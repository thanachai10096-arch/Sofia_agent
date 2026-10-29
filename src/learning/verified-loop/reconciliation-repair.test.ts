import test from "node:test";
import assert from "node:assert/strict";
import { planLearningReconciliationRepair } from "./reconciliation-repair.js";
import type { LearningScope } from "./ports.js";
import type { LearningRepairAuthorization } from "./reconciliation-repair.js";
import type { LearningReconciliationReport } from "./reconciliation.js";

const scope: LearningScope = { tenantId: "tenant-a", principalId: "user-a", projectId: "project-a" };
const report = (issues: LearningReconciliationReport["issues"]): LearningReconciliationReport => ({
  scope, checkedLearningSkills: 1, checkedRuntimeSkills: 0, issues, safe: issues.length === 0,
});
const auth = (overrides: Partial<LearningRepairAuthorization> = {}): LearningRepairAuthorization => ({
  scope, actorId: "operator-a", idempotencyKey: "repair-2026-10-29-001",
  approvedSkillIds: ["skill-1"], learningPolicyRevisions: { "skill-1": "policy-7" },
  currentPolicyRevisions: { "skill-1": "policy-7" }, trustedEvidenceSkillIds: ["skill-1"], ...overrides,
});

test("plans only explicitly approved missing runtime registration with current policy and trusted evidence", () => {
  const result = planLearningReconciliationRepair(report([{ kind: "missing-runtime-registration", skillId: "skill-1" }]), auth());
  assert.equal(result.eligibleForExecutor, true);
  assert.equal(result.actions.length, 1);
  assert.deepEqual(result.actions[0], {
    kind: "register-missing-runtime-skill", skillId: "skill-1", expectedPolicyRevision: "policy-7",
    scope, actorId: "operator-a", idempotencyKey: "repair-2026-10-29-001:skill-1",
  });
});

test("blocks repair without explicit approval or trusted evidence", () => {
  const noApproval = planLearningReconciliationRepair(report([{ kind: "missing-runtime-registration", skillId: "skill-1" }]), auth({ approvedSkillIds: [] }));
  assert.deepEqual(noApproval.blocked, [{ skillId: "skill-1", reason: "not-explicitly-approved" }]);
  const noEvidence = planLearningReconciliationRepair(report([{ kind: "missing-runtime-registration", skillId: "skill-1" }]), auth({ trustedEvidenceSkillIds: [] }));
  assert.deepEqual(noEvidence.blocked, [{ skillId: "skill-1", reason: "trusted-evidence-missing" }]);
  assert.equal(noEvidence.eligibleForExecutor, false);
});

test("blocks policy drift, duplicates, and mixed issues rather than guessing a repair", () => {
  const stale = planLearningReconciliationRepair(report([{ kind: "missing-runtime-registration", skillId: "skill-1" }]), auth({ currentPolicyRevisions: { "skill-1": "policy-8" } }));
  assert.deepEqual(stale.blocked, [{ skillId: "skill-1", reason: "policy-revision-stale" }]);
  const conflict = planLearningReconciliationRepair(report([
    { kind: "missing-runtime-registration", skillId: "skill-1" },
    { kind: "policy-revision-mismatch", skillId: "skill-1", learningRevision: "old", runtimeRevision: "new" },
  ]), auth());
  assert.deepEqual(conflict.blocked, [{ skillId: "skill-1", reason: "conflicting-issues" }]);
  const duplicate = planLearningReconciliationRepair(report([{ kind: "duplicate-learning-skill-id", skillId: "skill-1" }]), auth());
  assert.deepEqual(duplicate.blocked, [{ skillId: "skill-1", reason: "unsupported-issue" }]);
});

test("rejects cross-scope authorization and invalid idempotency keys", () => {
  assert.throws(
    () => planLearningReconciliationRepair(report([]), auth({ scope: { ...scope, tenantId: "tenant-b" } })),
    /scope/,
  );
  assert.throws(
    () => planLearningReconciliationRepair(report([]), auth({ idempotencyKey: " " })),
    /authorization/,
  );
});

test("rejects inconsistent reconciliation report metadata", () => {
  assert.throws(() => planLearningReconciliationRepair(
    { ...report([{ kind: "missing-runtime-registration", skillId: "skill-1" }]), safe: true }, auth(),
  ), /Invalid reconciliation report/);
});
