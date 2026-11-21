import assert from "node:assert/strict";
import test from "node:test";
import { runVerification, verificationCriteria } from "./verification.js";
import type { ToolGateway } from "./types.js";

test("verification criteria run in typecheck, test, build order", () => {
  assert.deepEqual(
    verificationCriteria().map((item) => item.id),
    ["project-typecheck", "project-test", "project-build"],
  );
});

test("verification stops after the first failed probe", async () => {
  const calls: string[] = [];
  const gateway: ToolGateway = {
    describe() { return { effects: ["read"] }; },
    async execute(call) {
      calls.push(String(call.input.kind));
      return {
        ok: false,
        data: { passed: false, code: 1, stderr: "type error" },
        evidenceId: "e1",
        error: { category: "type_error", message: "type error" },
      };
    },
    async snapshot() {
      return { id: "s1", revision: "r1", evidenceId: "e0" };
    },
    async changedFiles() { return []; },
    async checkpoint() { return { id: "c1", revision: "r1" }; },
    async rollback() { return []; },
  };

  const results = await runVerification(
    gateway,
    ["typecheck", "test", "build"],
    new AbortController().signal,
  );

  assert.deepEqual(calls, ["typecheck"]);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.passed, false);
});


test("verification preserves failed probes without evidence as recoverable failures", async () => {
  const gateway: ToolGateway = {
    describe() { return { effects: ["read"] }; },
    async execute() {
      return {
        ok: false,
        data: null,
        evidenceId: "",
        error: { category: "tool_error", message: "probe failed before evidence was recorded" },
      };
    },
    async snapshot() { return { id: "s1", revision: "r1", evidenceId: "e0" }; },
    async changedFiles() { return []; },
    async checkpoint() { return { id: "c1", revision: "r1" }; },
    async rollback() { return []; },
  };

  const results = await runVerification(gateway, ["typecheck"], new AbortController().signal);

  assert.equal(results.length, 1);
  assert.equal(results[0]?.passed, false);
  assert.deepEqual(results[0]?.evidenceIds, []);
  assert.match(results[0]?.detail ?? "", /probe failed/);
});

test("verification fails closed when a successful probe has no evidence ID", async () => {
  const gateway: ToolGateway = {
    describe() { return { effects: ["read"] }; },
    async execute() {
      return { ok: true, data: { passed: true, code: 0 }, evidenceId: "  " };
    },
    async snapshot() { return { id: "s1", revision: "r1", evidenceId: "e0" }; },
    async changedFiles() { return []; },
    async checkpoint() { return { id: "c1", revision: "r1" }; },
    async rollback() { return []; },
  };

  await assert.rejects(
    runVerification(gateway, ["typecheck"], new AbortController().signal),
    /succeeded without evidence/,
  );
});
