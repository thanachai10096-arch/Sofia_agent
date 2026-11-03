import test from "node:test";
import assert from "node:assert/strict";
import { createLearningRepairAuthorizationFromRecovery, inspectLearningRecovery } from "./recovery-coordinator.js";
import { planLearningReconciliationRepair } from "./reconciliation-repair.js";
import { executeLearningRepairPlan } from "./reconciliation-repair-executor.js";
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


test("recovery inspection maps persisted approval receipts into planner authorization", async () => {
  const h = host();
  const inspection = await inspectLearningRecovery(scope, h.adapter);
  const authorization = createLearningRepairAuthorizationFromRecovery(inspection, "repair-plan-1");
  assert.ok(authorization);
  assert.equal(authorization.actorId, "operator-a");
  assert.deepEqual(authorization.approvedSkillIds, ["skill-1"]);
  assert.equal(authorization.approvalIds["skill-1"], "receipt-1");
  assert.equal(authorization.learningPolicyRevisions["skill-1"], "policy-1");
  assert.equal(authorization.currentPolicyRevisions["skill-1"], "policy-1");
  assert.deepEqual(authorization.trustedEvidenceSkillIds, ["skill-1"]);
  assert.deepEqual(authorization.scope, scope);
});

test("recovery inspection cannot create planner authorization without an eligible receipt", async () => {
  const h = host({ approved: false });
  const inspection = await inspectLearningRecovery(scope, h.adapter);
  assert.equal(createLearningRepairAuthorizationFromRecovery(inspection, "repair-plan-2"), undefined);
});

test("recovery authorization bridge rejects eligible assessments with mixed approval actors", async () => {
  const h = host();
  const inspection = await inspectLearningRecovery(scope, h.adapter);
  const assessment = inspection.assessments[0]!;
  const mixed = {
    ...inspection,
    assessments: [
      assessment,
      {
        ...assessment,
        skillId: "skill-2",
        approvalBinding: {
          ...assessment.approvalBinding!,
          id: "receipt-2",
          actorId: "other-operator",
          skillId: "skill-2",
        },
      },
    ],
  };
  assert.throws(
    () => createLearningRepairAuthorizationFromRecovery(mixed, "repair-plan-3"),
    /invalid approval binding/,
  );
});

test("coordinator rejects approval receipts bound to another actor, scope, or policy", async () => {
  const mismatches = [
    { actorId: "other-operator", scope, policyRevision: "policy-1" },
    { actorId: "operator-a", scope: { ...scope, tenantId: "other-tenant" }, policyRevision: "policy-1" },
    { actorId: "operator-a", scope, policyRevision: "stale-policy" },
  ];
  for (const binding of mismatches) {
    const h = host();
    // Mutate the fixture's authoritative resolver result directly so each
    // iteration proves the coordinator rejects the exact mismatched receipt.
    h.state.approvalBinding = {
      id: "receipt-1",
      actorId: binding.actorId,
      skillId: "skill-1",
      scope: binding.scope,
      policyRevision: binding.policyRevision,
      status: "approved",
    };
    const result = await inspectLearningRecovery(scope, h.adapter);
    assert.equal(result.assessments[0]?.disposition, "blocked-approval");
    assert.match(result.assessments[0]?.reason ?? "", /different actor, skill, scope, or policy revision/);
  }
});


test("approval receipt flows from read-only recovery through planner into journaled executor", async () => {
  const h = host();
  let runtimeActive = false;
  const inspection = await inspectLearningRecovery(scope, h.adapter);
  const authorization = createLearningRepairAuthorizationFromRecovery(inspection, "end-to-end-repair");
  assert.ok(authorization);
  const plan = planLearningReconciliationRepair(inspection.report, authorization);
  assert.equal(plan.eligibleForExecutor, true);
  assert.equal(plan.actions[0]?.approvalId, "receipt-1");

  const entries = new Map<string, {
    key: string; scope: LearningScope; skillId: string; policyRevision: string;
    state: "running" | "succeeded" | "failed"; attempts: number; updatedAt: string;
    claimed?: boolean; claimToken?: string;
  }>();
  const events: string[] = [];
  const journal = {
    async get(key: string) { return entries.get(key); },
    async begin(entry: typeof entries extends Map<string, infer V> ? V : never) {
      const prior = entries.get(entry.key);
      if (prior?.state === "running" || prior?.state === "succeeded") return { ...prior, claimed: false };
      const claimed = { ...entry, state: "running" as const, attempts: (prior?.attempts ?? 0) + 1, claimed: true, claimToken: "e2e-claim" };
      entries.set(entry.key, claimed);
      return claimed;
    },
    async finish(key: string, _scope: LearningScope, state: "running" | "succeeded" | "failed", result?: string, claimToken?: string) {
      const prior = entries.get(key);
      if (!prior || prior.claimToken !== claimToken) throw new Error("claim lost");
      entries.set(key, { ...prior, state, ...(result ? { result } : {}), claimToken: undefined });
    },
    async heartbeat(key: string, _scope: LearningScope, claimToken: string) {
      return entries.get(key)?.claimToken === claimToken;
    },
    async audit(event: { event: string }) { events.push(event.event); },
  };
  const execution = await executeLearningRepairPlan(plan, journal, {
    async revalidate(action) {
      const binding = h.state.approvalBinding;
      return {
        scope, exists: runtimeActive, active: runtimeActive,
        policyRevision: h.state.policy, explicitlyApproved: h.state.approved,
        trustedEvidenceValid: h.state.evidence,
        approvalBinding: binding && { ...binding, skillId: action.skillId },
      };
    },
    async registerThroughLifecycle(action) {
      assert.equal(action.approvalId, "receipt-1");
      runtimeActive = true;
    },
    now: () => new Date("2026-11-03T00:00:00.000Z"),
  });
  assert.equal(execution[0]?.state, "succeeded");
  assert.equal(runtimeActive, true);
  assert.equal(entries.get(plan.actions[0]!.idempotencyKey)?.state, "succeeded");
  assert.deepEqual(events, ["repair_started", "repair_revalidated", "repair_registered", "repair_succeeded"]);
});
