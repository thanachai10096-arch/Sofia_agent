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
    async getExperienceByReceipt(s, receiptId) { return experiences.find(x => x.receiptId === receiptId && x.scope.tenantId === s.tenantId && x.scope.principalId === s.principalId && x.scope.projectId === s.projectId); },
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
    async promoteCandidate() { return true; },
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
test("rejects a receipt whose stored ID differs from the requested receipt ID", async () => {
  const state = makeHost();
  const loop = new VerifiedLearningLoop(state.host);
  addReceipt(state, "requested-id", "run1");
  state.receipts.set("requested-id", {
    ...state.receipts.get("requested-id")!,
    id: "different-id",
  });

  const result = await loop.recordVerifiedCompletion(scope, "requested-id", "Fix TypeScript build");
  assert.equal(result.recorded, false);
  assert.equal(state.experiences.length, 0);
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

test("runs policy assessment and regression outside the persistence transaction", async () => {
  const state = makeHost();
  let transactionDepth = 0;
  const transaction = state.host.transaction.bind(state.host);
  state.host.transaction = async (requestedScope, operation) => {
    transactionDepth++;
    try { return await transaction(requestedScope, operation); }
    finally { transactionDepth--; }
  };
  const assess = state.host.assessCandidate.bind(state.host);
  state.host.assessCandidate = async (requestedScope, candidate) => {
    assert.equal(transactionDepth, 0, "policy assessment must not run under a write transaction");
    return assess(requestedScope, candidate);
  };
  const regression = state.host.verification.runRegression.bind(state.host.verification);
  state.host.verification.runRegression = async (requestedScope, candidate) => {
    assert.equal(transactionDepth, 0, "regression execution must not run under a write transaction");
    return regression(requestedScope, candidate);
  };
  const loop = new VerifiedLearningLoop(state.host);
  addReceipt(state, "tx-1", "run1");
  addReceipt(state, "tx-2", "run2");
  addReceipt(state, "tx-3", "run3");
  await loop.recordVerifiedCompletion(scope, "tx-1", "Fix TypeScript build");
  await loop.recordVerifiedCompletion(scope, "tx-2", "Fix TypeScript build");
  const result = await loop.recordVerifiedCompletion(scope, "tx-3", "Fix TypeScript build");
  assert.ok(result.skillActivated);
});

test("resumes candidate evaluation when an earlier attempt persisted the receipt experience only", async () => {
  const state = makeHost();
  const loop = new VerifiedLearningLoop(state.host);
  addReceipt(state, "resume-1", "run1");
  addReceipt(state, "resume-2", "run2");
  addReceipt(state, "resume-3", "run3");
  await loop.recordVerifiedCompletion(scope, "resume-1", "Fix TypeScript build");
  await loop.recordVerifiedCompletion(scope, "resume-2", "Fix TypeScript build");

  // Simulate a crash after the third experience committed but before the
  // candidate was assessed or persisted.
  const receipt = state.receipts.get("resume-3")!;
  const firstExperience = state.experiences[0];
  assert.ok(firstExperience, "expected prior verified experience before simulating recovery");
  state.experiences.push({
    id: "interrupted-experience", scope, receiptId: receipt.id, runId: receipt.runId,
    evidenceIds: [...receipt.evidenceIds], summary: "Fix TypeScript build",
    taskFingerprint: firstExperience.taskFingerprint, createdAt: new Date().toISOString(),
  });
  const resumed = await loop.recordVerifiedCompletion(scope, "resume-3", "Fix TypeScript build");
  assert.ok(resumed.skillActivated);
  assert.equal(state.active.length, 1);
});


test("fails closed when the regression adapter returns malformed output", async () => {
  const state = makeHost();
  state.host.verification.runRegression = async () => ({} as SkillEvaluation);
  const loop = new VerifiedLearningLoop(state.host);
  addReceipt(state, "malformed-regression-1", "run1");
  addReceipt(state, "malformed-regression-2", "run2");
  addReceipt(state, "malformed-regression-3", "run3");

  await loop.recordVerifiedCompletion(scope, "malformed-regression-1", "Fix TypeScript build");
  await loop.recordVerifiedCompletion(scope, "malformed-regression-2", "Fix TypeScript build");
  const result = await loop.recordVerifiedCompletion(scope, "malformed-regression-3", "Fix TypeScript build");

  assert.equal(result.recorded, true);
  assert.equal(result.skillActivated, undefined);
  assert.equal(state.active.length, 0);
});

test("does not activate a learned skill without the existing lifecycle promotion gate", async () => {
  const state = makeHost();
  delete state.host.promoteCandidate;
  const loop = new VerifiedLearningLoop(state.host);
  addReceipt(state, "no-gate-1", "run1");
  addReceipt(state, "no-gate-2", "run2");
  addReceipt(state, "no-gate-3", "run3");
  await loop.recordVerifiedCompletion(scope, "no-gate-1", "Fix TypeScript build");
  await loop.recordVerifiedCompletion(scope, "no-gate-2", "Fix TypeScript build");
  const result = await loop.recordVerifiedCompletion(scope, "no-gate-3", "Fix TypeScript build");
  assert.equal(result.skillActivated, undefined);
  assert.equal(state.active.length, 0);
});

 
test("does not activate a skill if policy changes during lifecycle promotion", async () => {
  const state = makeHost();
  state.host.promoteCandidate = async () => {
    // Simulate policy changing while the lifecycle gate is doing external work.
    state.host.currentPolicyRevision = async () => "policy-2";
    return true;
  };
  const loop = new VerifiedLearningLoop(state.host);
  addReceipt(state, "policy-race-1", "run1");
  addReceipt(state, "policy-race-2", "run2");
  addReceipt(state, "policy-race-3", "run3");

  await loop.recordVerifiedCompletion(scope, "policy-race-1", "Fix TypeScript build");
  await loop.recordVerifiedCompletion(scope, "policy-race-2", "Fix TypeScript build");
  const result = await loop.recordVerifiedCompletion(scope, "policy-race-3", "Fix TypeScript build");

  assert.equal(result.skillActivated, undefined);
  assert.equal(state.active.length, 0);
});

test("duplicate receipt cannot be reinterpreted with a different task summary", async () => {
  const state = makeHost();
  const loop = new VerifiedLearningLoop(state.host);
  addReceipt(state, "replay-1", "run1");
  addReceipt(state, "replay-2", "run2");
  addReceipt(state, "replay-3", "run3");

  // Establish a repeated task pattern without promoting it, then persist a
  // different task for the third receipt. Replaying that receipt with the
  // repeated summary must not attach the receipt to the unrelated task pattern.
  state.host.assessCandidate = async () => ({ allowed: false, confidence: 0.9 });
  await loop.recordVerifiedCompletion(scope, "replay-1", "Fix TypeScript build");
  await loop.recordVerifiedCompletion(scope, "replay-2", "Fix TypeScript build");
  await loop.recordVerifiedCompletion(scope, "replay-3", "Deploy production");

  state.host.assessCandidate = async (_scope, candidate) => ({
    allowed: true,
    confidence: Math.max(candidate.confidence, 0.9),
  });
  const replay = await loop.recordVerifiedCompletion(scope, "replay-3", "Fix TypeScript build");
  assert.equal(replay.skillActivated, undefined);
  assert.equal(state.active.length, 0);
  assert.equal(
    replay.experienceId,
    state.experiences.find(item => item.receiptId === "replay-3")?.id,
  );
  assert.equal(
    state.experiences.find(item => item.receiptId === "replay-3")?.summary,
    "Deploy production",
  );
});
