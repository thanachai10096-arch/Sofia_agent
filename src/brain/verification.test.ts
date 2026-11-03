import assert from "node:assert/strict";
import test from "node:test";
import { runVerification, verificationCriteria } from "./verification.js";
import type { ToolGateway } from "./types.js";

test("verification rejects an empty probe set instead of vacuously passing", async () => {
  const gateway = {
    describe() { return { effects: ["read"] as const }; },
    async execute() { throw new Error("must not execute"); },
    async snapshot() { return { id: "s1", revision: "r1", evidenceId: "snapshot-evidence" }; },
    async changedFiles() { return []; },
    async checkpoint() { return { id: "c1", revision: "r1" }; },
    async rollback() { return []; },
  } satisfies ToolGateway;

  await assert.rejects(
    runVerification(gateway, [], new AbortController().signal),
    /at least one acceptance probe/i,
  );
});

test("verification rejects snapshots without durable identity and evidence", async () => {
  const gateway: ToolGateway = {
    describe() { return { effects: ["read"] }; },
    async execute() { throw new Error("must not execute"); },
    async snapshot() { return { id: "s1", revision: "r1", evidenceId: " " }; },
    async changedFiles() { return []; },
    async checkpoint() { return { id: "c1", revision: "r1" }; },
    async rollback() { return []; },
  };

  await assert.rejects(
    runVerification(gateway, ["typecheck"], new AbortController().signal),
    /incomplete workspace identity or evidence/i,
  );
});

test("verification criteria run in typecheck, test, build order", () => {
  assert.deepEqual(
    verificationCriteria().map((item) => item.id),
    ["project-typecheck", "project-test", "project-build"],
  );
});

test("verification cannot pass without a durable evidence ID", async () => {
  let calls = 0;
  const gateway: ToolGateway = {
    describe() { return { effects: ["read"] }; },
    async execute() {
      calls += 1;
      return {
        ok: true,
        data: { passed: true, code: 0, stdout: "all checks passed" },
        evidenceId: "   ",
      };
    },
    async snapshot() {
      return { id: "s1", revision: "r1", evidenceId: "snapshot-evidence" };
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

  assert.equal(calls, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.passed, false);
  assert.deepEqual(results[0]?.evidenceIds, []);
  assert.match(results[0]?.detail ?? "", /no evidence ID/i);
});

test("verification rejects oversized evidence references", async () => {
  const gateway: ToolGateway = {
    describe() { return { effects: ["read"] }; },
    async execute() {
      return { ok: true, data: { passed: true, code: 0 }, evidenceId: "e".repeat(501) };
    },
    async snapshot() { return { id: "s1", revision: "r1", evidenceId: "snapshot-evidence" }; },
    async changedFiles() { return []; },
    async checkpoint() { return { id: "c1", revision: "r1" }; },
    async rollback() { return []; },
  };

  const results = await runVerification(gateway, ["typecheck"], new AbortController().signal);
  assert.equal(results[0]?.passed, false);
  assert.deepEqual(results[0]?.evidenceIds, []);
  assert.match(results[0]?.detail ?? "", /no evidence ID/i);
});

test("verification fails closed when the workspace changes during a probe", async () => {
  let snapshots = 0;
  const gateway: ToolGateway = {
    describe() { return { effects: ["read"] }; },
    async execute() {
      return {
        ok: true,
        data: { passed: true, code: 0, stdout: "all checks passed" },
        evidenceId: "probe-evidence",
      };
    },
    async snapshot() {
      snapshots += 1;
      return { id: "s" + snapshots, revision: snapshots === 1 ? "r1" : "r2", evidenceId: "snapshot-evidence-" + snapshots };
    },
    async changedFiles() { return []; },
    async checkpoint() { return { id: "c1", revision: "r1" }; },
    async rollback() { return []; },
  };

  const results = await runVerification(gateway, ["typecheck", "test"], new AbortController().signal);

  assert.equal(snapshots, 2);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.passed, false);
  assert.deepEqual(results[0]?.evidenceIds, ["probe-evidence"]);
  assert.match(results[0]?.detail ?? "", /revision changed/i);
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
