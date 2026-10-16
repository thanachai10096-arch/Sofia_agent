// Modified for Sofia Agents Skill Engine integration on 2026-10-13; provenance notes: docs/engineering/CODE_PROVENANCE_AUDIT.md.
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


test("verification carries structured assertion metrics without inventing them", async () => {
  const gateway: ToolGateway = {
    describe() { return { effects: ["read"] }; },
    async execute() {
      return {
        ok: true,
        data: {
          passed: true,
          code: 0,
          assertionsPassed: true,
          assertionsTotal: 17,
          failedAssertions: 0,
          skippedAssertions: 0,
        },
        evidenceId: "verification-evidence",
      };
    },
    async snapshot() {
      return { id: "s1", revision: "r1", evidenceId: "snapshot-evidence" };
    },
    async changedFiles() { return []; },
    async checkpoint() { return { id: "c1", revision: "r1" }; },
    async rollback() { return []; },
  };
  const [result] = await runVerification(gateway, ["test"], new AbortController().signal, "run-test");
  assert.equal(result?.passed, true);
  assert.equal(result?.exitCode, 0);
  assert.equal(result?.checksPassed, true);
  assert.equal(result?.assertionsPassed, true);
  assert.equal(result?.assertionsTotal, 17);
  assert.equal(result?.failedAssertions, 0);
  assert.equal(result?.skippedAssertions, 0);
});

test("verification leaves absent assertion metrics absent", async () => {
  const gateway: ToolGateway = {
    describe() { return { effects: ["read"] }; },
    async execute() {
      return { ok: true, data: { passed: true, code: 0 }, evidenceId: "verification-evidence" };
    },
    async snapshot() {
      return { id: "s1", revision: "r1", evidenceId: "snapshot-evidence" };
    },
    async changedFiles() { return []; },
    async checkpoint() { return { id: "c1", revision: "r1" }; },
    async rollback() { return []; },
  };
  const [result] = await runVerification(gateway, ["test"], new AbortController().signal, "run-test");
  assert.equal(result?.passed, true);
  assert.equal(result?.assertionsTotal, undefined);
  assert.equal(result?.failedAssertions, undefined);
  assert.equal(result?.skippedAssertions, undefined);
});


test("verification carries structured TAP test counts from the trusted project verifier", async () => {
  const gateway: ToolGateway = {
    describe() { return { effects: ["read"] }; },
    async execute() {
      return {
        ok: true,
        data: {
          passed: true,
          code: 0,
          testsTotal: 7,
          passedTests: 7,
          failedTests: 0,
          skippedTests: 0,
          cancelledTests: 0,
          todoTests: 0,
        },
        evidenceId: "tap-verification-evidence",
      };
    },
    async snapshot() {
      return { id: "s1", revision: "r1", evidenceId: "snapshot-evidence" };
    },
    async changedFiles() { return []; },
    async checkpoint() { return { id: "c1", revision: "r1" }; },
    async rollback() { return []; },
  };
  const [result] = await runVerification(gateway, ["test"], new AbortController().signal, "run-test");
  assert.equal(result?.passed, true);
  assert.equal(result?.testsTotal, 7);
  assert.equal(result?.passedTests, 7);
  assert.equal(result?.failedTests, 0);
  assert.equal(result?.skippedTests, 0);
  assert.equal(result?.cancelledTests, 0);
  assert.equal(result?.todoTests, 0);
});
