import test from "node:test";
import assert from "node:assert/strict";
import { inspectLearningRecovery } from "./recovery-coordinator.js";
import type { ActiveLearningSkill, LearningScope } from "./ports.js";
import type { RuntimeLearningSkill } from "./reconciliation.js";

const scope: LearningScope = { tenantId: "tenant-a", principalId: "user-a", projectId: "project-a" };
const skill: ActiveLearningSkill = {
  id: "skill-1", scope, experienceId: "experience-1", name: "learned-task",
  trigger: "task", procedure: ["inspect", "verify"], confidence: 0.9,
  status: "active", activatedAt: "2026-11-01T00:00:00.000Z", policyRevision: "policy-1",
};
function host(overrides: Partial<{
  learning: ActiveLearningSkill[];
  runtime: RuntimeLearningSkill[];
  policy: string;
  approved: boolean;
  evidence: boolean;
  calls: string[];
}> = {}) {
  const state = { learning: [skill], runtime: [] as RuntimeLearningSkill[], policy: "policy-1", approved: true, evidence: true, calls: [] as string[], ...overrides };
  return {
    state,
    adapter: {
      async listActiveLearningSkills() { state.calls.push("learning"); return state.learning; },
      async listRuntimeSkills() { state.calls.push("runtime"); return state.runtime; },
      async currentPolicyRevision() { state.calls.push("policy"); return state.policy; },
      async isExplicitlyApproved() { state.calls.push("approval"); return state.approved; },
      async hasTrustedEvidence() { state.calls.push("evidence"); return state.evidence; },
    },
  };
}

test("coordinator marks only fully gated missing registration as eligible for reviewed repair", async () => {
  const h = host();
  const result = await inspectLearningRecovery(scope, h.adapter);
  assert.equal(result.readOnly, true);
  assert.equal(result.report.safe, false);
  assert.deepEqual(result.assessments.map(item => item.disposition), ["eligible-for-reviewed-repair"]);
  assert.deepEqual(h.state.calls, ["learning", "runtime", "policy", "approval", "evidence"]);
});

test("coordinator blocks missing registration when policy has drifted", async () => {
  const h = host({ policy: "policy-2" });
  const result = await inspectLearningRecovery(scope, h.adapter);
  assert.equal(result.assessments[0]?.disposition, "blocked-policy-drift");
  assert.ok(!h.state.calls.includes("approval"));
  assert.ok(!h.state.calls.includes("evidence"));
});

test("coordinator requires explicit approval before resolving trusted evidence", async () => {
  const h = host({ approved: false });
  const result = await inspectLearningRecovery(scope, h.adapter);
  assert.equal(result.assessments[0]?.disposition, "blocked-approval");
  assert.ok(!h.state.calls.includes("evidence"));
});

test("coordinator blocks missing or untrusted evidence", async () => {
  const h = host({ evidence: false });
  const result = await inspectLearningRecovery(scope, h.adapter);
  assert.equal(result.assessments[0]?.disposition, "blocked-evidence");
});

test("coordinator routes runtime-only and policy mismatch states to manual review", async () => {
  const runtimeOnly: RuntimeLearningSkill = { id: "runtime-only", scope, policyRevision: "policy-1", active: true };
  const mismatch: RuntimeLearningSkill = { id: "skill-1", scope, policyRevision: "policy-2", active: true };
  const h = host({ runtime: [runtimeOnly, mismatch] });
  const result = await inspectLearningRecovery(scope, h.adapter);
  assert.deepEqual(result.assessments.map(item => item.disposition), ["manual-review", "manual-review"]);
  assert.ok(!h.state.calls.includes("approval"));
  assert.ok(!h.state.calls.includes("evidence"));
});

test("coordinator fails closed on invalid policy revision and cross-scope data", async () => {
  const invalid = host({ policy: " " });
  await assert.rejects(() => inspectLearningRecovery(scope, invalid.adapter), /invalid revision/);
  const crossed = host({ learning: [{ ...skill, scope: { ...scope, tenantId: "tenant-b" } }] });
  await assert.rejects(() => inspectLearningRecovery(scope, crossed.adapter), /Cross-scope/);
});
