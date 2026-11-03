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
  actorId: string;
  evidence: boolean;
  calls: string[];
  approvalBinding?: { id: string; actorId: string; skillId: string; scope: LearningScope; policyRevision: string; status: "approved" };
}> = {}) {
  const state = { learning: [skill], runtime: [] as RuntimeLearningSkill[], policy: "policy-1", approved: true, actorId: "operator-a", evidence: true, calls: [] as string[], approvalBinding: { id: "receipt-1", actorId: "operator-a", skillId: "skill-1", scope, policyRevision: "policy-1", status: "approved" as const }, ...overrides };
  return {
    state,
    adapter: {
      async listActiveLearningSkills() { state.calls.push("learning"); return state.learning; },
      async listRuntimeSkills() { state.calls.push("runtime"); return state.runtime; },
      async currentPolicyRevision() { state.calls.push("policy"); return state.policy; },
      async authenticatedActorId() { state.calls.push("actor"); return state.actorId; },
      async isExplicitlyApproved() { state.calls.push("approval"); return state.approved; },
      async resolveApprovalBinding() { state.calls.push("approval-receipt"); return state.approvalBinding; },
      async hasTrustedEvidence() { state.calls.push("evidence"); return state.evidence; },
    },
  };
}

test("coordinator returns a clean read-only inspection when stores agree", async () => {
  const runtime: RuntimeLearningSkill = { id: "skill-1", scope, policyRevision: "policy-1", active: true };
  const h = host({ runtime: [runtime] });
  const result = await inspectLearningRecovery(scope, h.adapter);
  assert.equal(result.readOnly, true);
  assert.equal(result.report.safe, true);
  assert.deepEqual(result.assessments, []);
});

test("coordinator marks only fully gated missing registration as eligible for reviewed repair", async () => {
  const h = host();
  const result = await inspectLearningRecovery(scope, h.adapter);
  assert.equal(result.readOnly, true);
  assert.equal(result.report.safe, false);
  assert.deepEqual(result.assessments.map(item => item.disposition), ["eligible-for-reviewed-repair"]);
  assert.equal(result.assessments[0]?.approvalBinding?.id, "receipt-1");
  assert.deepEqual(h.state.calls, ["learning", "runtime", "policy", "approval", "actor", "approval-receipt", "evidence", "policy"]);
});

test("coordinator sends an existing inactive runtime entry to manual review", async () => {
  const inactive: RuntimeLearningSkill = { id: "skill-1", scope, policyRevision: "policy-1", active: false };
  const h = host({ runtime: [inactive] });
  const result = await inspectLearningRecovery(scope, h.adapter);
  assert.equal(result.assessments[0]?.disposition, "manual-review");
  assert.match(result.assessments[0]?.reason ?? "", /inactive/);
  assert.ok(!h.state.calls.includes("approval"));
  assert.ok(!h.state.calls.includes("evidence"));
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

test("coordinator detects policy drift that occurs during evidence revalidation", async () => {
  const h = host();
  let reads = 0;
  h.adapter.currentPolicyRevision = async () => {
    reads += 1;
    h.state.calls.push("policy");
    return reads === 1 ? "policy-1" : "policy-2";
  };
  const result = await inspectLearningRecovery(scope, h.adapter);
  assert.equal(result.assessments[0]?.disposition, "blocked-policy-drift");
  assert.equal(result.assessments[0]?.currentPolicyRevision, "policy-2");
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

test("coordinator propagates authoritative host read failures without returning an assessment", async () => {
  const h = host();
  h.adapter.listRuntimeSkills = async () => { throw new Error("runtime registry unavailable"); };
  await assert.rejects(() => inspectLearningRecovery(scope, h.adapter), /runtime registry unavailable/);
});

test("coordinator fails closed on invalid policy revision and cross-scope data", async () => {
  const invalid = host({ policy: " " });
  await assert.rejects(() => inspectLearningRecovery(scope, invalid.adapter), /invalid revision/);
  const crossed = host({ learning: [{ ...skill, scope: { ...scope, tenantId: "tenant-b" } }] });
  await assert.rejects(() => inspectLearningRecovery(scope, crossed.adapter), /Cross-scope/);
});


test("coordinator blocks boolean-only approval when receipt resolver is unavailable", async () => {
  const h = host();
  const adapter = { ...h.adapter, resolveApprovalBinding: undefined };
  const result = await inspectLearningRecovery(scope, adapter);
  assert.equal(result.assessments[0]?.disposition, "blocked-approval");
  assert.match(result.assessments[0]?.reason ?? "", /persisted receipt/);
});

test("coordinator rejects approval receipts bound to another actor, scope, or policy", async () => {
  const mismatches = [
    { actorId: "other-operator" },
    { scope: { ...scope, tenantId: "other-tenant" } },
    { policyRevision: "stale-policy" },
  ];
  for (const override of mismatches) {
    const h = host({ approvalBinding: { id: "receipt-1", actorId: "operator-a", skillId: "skill-1", scope, policyRevision: "policy-1", status: "approved", ...override } });
    const result = await inspectLearningRecovery(scope, h.adapter);
    assert.equal(result.assessments[0]?.disposition, "blocked-approval");
  }
});
