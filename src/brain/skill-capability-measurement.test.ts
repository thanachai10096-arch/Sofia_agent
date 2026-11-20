import assert from "node:assert/strict";
import test from "node:test";
import { measureSkillCapability } from "./skill-capability-measurement.js";

test("capability measurement scores complete passing checks at 100", () => {
  const result = measureSkillCapability({
    checks: [{ name: "typecheck", passed: true }, { name: "test", passed: true }],
  });
  assert.equal(result.score, 100);
  assert.equal(result.passRate, 1);
  assert.equal(result.baselineCoverage, 1);
});

test("capability measurement penalizes failed checks and missing baseline coverage", () => {
  const result = measureSkillCapability({
    baseline: [{ name: "typecheck", passed: true }, { name: "test", passed: true }],
    checks: [{ name: "typecheck", passed: true }, { name: "build", passed: false }],
  });
  assert.equal(result.passedChecks, 1);
  assert.equal(result.totalChecks, 2);
  assert.equal(result.baselineCoverage, 0.5);
  assert.equal(result.score, 25);
  assert.deepEqual(result.missingBaselineChecks, ["test"]);
  assert.deepEqual(result.failedChecks, ["build"]);
});

test("capability measurement rejects empty and duplicate check sets", () => {
  assert.throws(() => measureSkillCapability({ checks: [] }), /non-empty/);
  assert.throws(() => measureSkillCapability({
    checks: [{ name: "test", passed: true }, { name: " test ", passed: true }],
  }), /duplicate/);
});

test("capability measurement uses full baseline coverage when no prior baseline exists", () => {
  const result = measureSkillCapability({
    checks: [{ name: "typecheck", passed: true }, { name: "test", passed: false }],
    baseline: [],
  });
  assert.equal(result.score, 50);
  assert.equal(result.baselineChecks, 0);
});
