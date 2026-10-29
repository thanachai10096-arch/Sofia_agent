import test from "node:test";
import assert from "node:assert/strict";
import { VerifiedLearningLoop } from "./loop.js";
import type {
  LearningExperience, LearningScope, LearningTransaction, RunEvidence, SkillCandidate,
  SkillEvaluation, ActiveLearningSkill, VerificationReceipt, VerifiedLearningHost,
} from "./ports.js";

const scope: LearningScope = { tenantId: "tenant", principalId: "user", projectId: "project" };
function makeHost() {
  const receipts = new Map<string, VerificationReceipt>();
  const evidence = new Map<string, RunEvidence>();
  const experiences: LearningExperience[] = [];
  const candidates = new Map<string, SkillCandidate>();
  const evaluations = new Map<string, SkillEvaluation>();
  const active: ActiveLearningSkill[] = [];
  const tx: LearningTransaction = {
    async insertExperienceIfAbsent(item) {
      if (experiences.some(old => old.scope.tenantId === item.scope.tenantId && old.scope.principalId === item.scope.principalId && old.scope.projectId === item.scope.projectId && old.receiptId === item.receiptId)) return false;
      experiences.push(item); return true;
    },
    async listExperiences(s, limit) { return experiences.filter(x => x.scope.tenantId === s.tenantId && x.scope.principalId === s.principalId && x.scope.projectId === s.projectId).slice(-limit); },
    async getExperience(s, id) { return experiences.find(x => x.id === id && x.scope.tenantId === s.tenantId && x.scope.principalId === s.principalId && x.scope.projectId === s.projectId); },
    async putCandidate(item) { candidates.set(item.id, item); },
    async getCandidate(s, id) { const item = candidates.get(id); return item && item.scope.tenantId === s.tenantId && item.scope.principalId === s.principalId && item.scope.projectId === s.projectId ? item : undefined; },
    async recordEvaluation(_s, id, evaluation) { evaluations.set(id, evaluation); },
    async activateSkill(skill) { active.push(skill); },
    async listActiveSkills(s) { return active.filter(x => x.scope.tenantId === s.tenantId && x.scope.principalId === s.principalId && x.scope.projectId === s.projectId); },
  };
  const host: VerifiedLearningHost = {
    async transaction(_scope, operation) { return operation(tx); },
    verification: {
      async getReceipt(_scope, id) { return receipts.get(id); },
      async getEvidence(_scope, ids) { return ids.map(id => evidence.get(id)).filter((x): x is RunEvidence => Boolean(x)); },
      async runRegression(_scope, candidate) {
        const runId = "regression-run-" + candidate.id;
        const id = "reg-" + candidate.id;
        evidence.set(id, { id, runId, scope, kind: "regression", trusted: true, success: true, content: "passed", createdAt: new Date().toISOString() });
        return { regressionRunId: runId, passed: true, checks: [{ name: "regression", passed: true }], regressionEvidenceIds: [id] };
      },
    },
    async currentPolicyRevision() { return "policy-1"; },
    redact(value) { return value.replace(/secret/gi, "[redacted]"); },
    async assessCandidate(_scope, candidate) { return { allowed: true, confidence: Math.max(candidate.confidence, 0.9) }; },
  };
  return { host, receipts, evidence, experiences, active, evaluations };
}
function addReceipt(state: ReturnType<typeof makeHost>, receiptId: string, runId: string) {
  const evidenceId = "evidence-" + receiptId;
  const receipt: VerificationReceipt = {
    id: receiptId, runId, scope, completed: true, verified: true, verifier: "trusted-verifier",
    evidenceIds: [evidenceId], policyRevision: "policy-1", completedAt: new Date().toISOString(),
  };
  state.receipts.set(receiptId, receipt);
  state.evidence.set(evidenceId, {
    id: evidenceId, runId, scope, kind: "verification", trusted: true, success: true,
    content: "passed", createdAt: new Date().toISOString(),
  });
}
test("learns only after repeated verified experiences and passing regression evidence", async () => {
  const state = makeHost();
  const loop = new VerifiedLearningLoop(state.host);
  addReceipt(state, "r1", "run1");
  addReceipt(state, "r2", "run2");
  addReceipt(state, "r3", "run3");
  assert.equal((await loop.recordVerifiedCompletion(scope, "r1", "Fix TypeScript build")).recorded, true);
  assert.equal(state.active.length, 0);
  assert.equal((await loop.recordVerifiedCompletion(scope, "r2", "Fix TypeScript build")).skillActivated, undefined);
  assert.equal(state.active.length, 0);
  const third = await loop.recordVerifiedCompletion(scope, "r3", "Fix TypeScript build");
  assert.ok(third.skillActivated);
  assert.equal(state.active.length, 1);
  assert.equal(state.evaluations.size, 1);
  assert.equal((await loop.retrieveSkills(scope, "TypeScript")).length, 1);
  assert.equal((await loop.retrieveSkills({ ...scope, tenantId: "other" }, "TypeScript")).length, 0);
});
test("does not learn from missing or cross-scope evidence and deduplicates receipts", async () => {
  const state = makeHost();
  const loop = new VerifiedLearningLoop(state.host);
  addReceipt(state, "r1", "run1");
  assert.equal((await loop.recordVerifiedCompletion(scope, "missing", "task")).recorded, false);
  const receipt = state.receipts.get("r1")!;
  state.receipts.set("r1", { ...receipt, scope: { ...scope, tenantId: "other" } });
  assert.equal((await loop.recordVerifiedCompletion(scope, "r1", "task")).recorded, false);
  state.receipts.set("r1", receipt);
  assert.equal((await loop.recordVerifiedCompletion(scope, "r1", "task")).recorded, true);
  assert.equal((await loop.recordVerifiedCompletion(scope, "r1", "task")).recorded, false);
  assert.equal(state.experiences.length, 1);
});
test("rejects stale policy receipts and untrusted evidence", async () => {
  const state = makeHost();
  const loop = new VerifiedLearningLoop(state.host);
  addReceipt(state, "r1", "run1");
  state.receipts.set("r1", { ...state.receipts.get("r1")!, policyRevision: "old-policy" });
  assert.equal((await loop.recordVerifiedCompletion(scope, "r1", "task")).recorded, false);
  state.receipts.set("r1", { ...state.receipts.get("r1")!, policyRevision: "policy-1" });
  state.evidence.set("evidence-r1", { ...state.evidence.get("evidence-r1")!, trusted: false });
  assert.equal((await loop.recordVerifiedCompletion(scope, "r1", "task")).recorded, false);
});

test("does not activate a candidate when assessment confidence is not finite", async () => {
  const state = makeHost();
  state.host.assessCandidate = async () => ({ allowed: true, confidence: Number.NaN });
  const loop = new VerifiedLearningLoop(state.host);
  addReceipt(state, "bad-1", "run1");
  addReceipt(state, "bad-2", "run2");
  addReceipt(state, "bad-3", "run3");
  await loop.recordVerifiedCompletion(scope, "bad-1", "Fix TypeScript build");
  await loop.recordVerifiedCompletion(scope, "bad-2", "Fix TypeScript build");
  const result = await loop.recordVerifiedCompletion(scope, "bad-3", "Fix TypeScript build");
  assert.equal(result.skillActivated, undefined);
  assert.equal(state.active.length, 0);
});
