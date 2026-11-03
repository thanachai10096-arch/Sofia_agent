import test from "node:test";
import assert from "node:assert/strict";
import { reconcileLearningActivationState } from "./reconciliation.js";
import type { ActiveLearningSkill, LearningScope } from "./ports.js";
import type { RuntimeLearningSkill } from "./reconciliation.js";

const scope: LearningScope = { tenantId: "tenant-a", principalId: "user-a", projectId: "project-a" };
function learned(id: string, policyRevision = "policy-1"): ActiveLearningSkill {
  return { id, scope, experienceId: "experience-1", name: "learned-task", trigger: "task", procedure: ["inspect", "verify"], confidence: 0.9, status: "active", activatedAt: "2026-10-29T00:00:00.000Z", policyRevision };
}
function runtime(id: string, policyRevision = "policy-1", active = true): RuntimeLearningSkill {
  return { id, scope, policyRevision, active };
}

test("reconciliation reports clean matching activation state", () => {
  const report = reconcileLearningActivationState(scope, [learned("skill-1")], [runtime("skill-1")]);
  assert.equal(report.safe, true);
  assert.deepEqual(report.issues, []);
});
test("reconciliation detects missing runtime registration after interrupted promotion", () => {
  const report = reconcileLearningActivationState(scope, [learned("skill-1")], []);
  assert.equal(report.safe, false);
  assert.deepEqual(report.issues, [{ kind: "missing-runtime-registration", skillId: "skill-1" }]);
});
test("reconciliation detects runtime-only activations and policy drift", () => {
  const report = reconcileLearningActivationState(scope, [learned("skill-1", "policy-old")], [runtime("skill-1", "policy-new"), runtime("skill-2")]);
  assert.equal(report.safe, false);
  assert.deepEqual(report.issues, [
    { kind: "policy-revision-mismatch", skillId: "skill-1", learningRevision: "policy-old", runtimeRevision: "policy-new" },
    { kind: "runtime-active-without-learning-record", skillId: "skill-2" },
  ]);
});
test("reconciliation rejects cross-scope records rather than leaking activation state", () => {
  assert.throws(() => reconcileLearningActivationState(scope, [{ ...learned("skill-1"), scope: { ...scope, tenantId: "tenant-b" } }], []), /Cross-scope/);
  assert.throws(() => reconcileLearningActivationState(scope, [], [{ ...runtime("skill-1"), scope: { ...scope, projectId: "other-project" } }]), /Cross-scope/);
});
test("reconciliation reports duplicate identifiers instead of silently choosing a record", () => {
  const report = reconcileLearningActivationState(scope, [learned("skill-1"), learned("skill-1")], [runtime("skill-1"), runtime("skill-1")]);
  assert.deepEqual(report.issues, [
    { kind: "duplicate-learning-skill-id", skillId: "skill-1" },
    { kind: "duplicate-runtime-skill-id", skillId: "skill-1" },
  ]);
});
