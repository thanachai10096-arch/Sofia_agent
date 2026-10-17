import test from "node:test";
import assert from "node:assert/strict";
import {
  checkpointManager, naturalConversation, userPreferenceMemory, conversationToTaskParser,
  clarifyingQuestionPlanner, sessionHandoff, memoryRetentionPolicy, coverageGapAnalyzer,
  sourceCredibilityRanker, crossSourceSynthesizer, factConflictDetector, researchBriefWriter,
  scheduledJobPlanner, idempotencyGuard, costLatencyAnalyzer, offlineEvaluationRunner,
  skillRollbackManager, registerVerifiedPlanningAnalysisSkills,
} from "./planning-analysis-handlers.js";
import { AdvancedSkillRegistry } from "./advanced-skill-runtime.js";

test("checkpoint manager fails closed for unverified or secret-bearing checkpoint metadata", () => {
  assert.equal((checkpointManager({ checkpointId: "c1", createdAt: 1, currentVersion: "1", checkpointVersion: "1", containsSecrets: false, integrityVerified: false }) as any).recommendation, "reject-integrity-unverified");
  assert.equal((checkpointManager({ checkpointId: "c1", createdAt: 1, currentVersion: "1", checkpointVersion: "1", containsSecrets: true, integrityVerified: true }) as any).restorePerformed, false);
});
test("conversation utilities preserve only supplied intent and explicit task lines", () => {
  assert.equal((naturalConversation({ message: "  Please fix this " }) as any).likelyActionRequest, true);
  const tasks = conversationToTaskParser({ message: "Do this\n- First task\n2. Second task\nMaybe later" }) as any;
  assert.deepEqual(tasks.tasks.map((x: any) => x.description), ["First task", "Second task"]);
  assert.equal(tasks.executed, false);
});
test("preference extraction requests confirmation and does not persist", () => {
  const result = userPreferenceMemory({ statements: ["I prefer concise answers", "The weather is nice"] }) as any;
  assert.equal(result.candidates.length, 1);
  assert.equal(result.stored, false);
});
test("clarification and handoff are bounded and do not mutate session", () => {
  const plan = clarifyingQuestionPlanner({ goal: "Deploy safely", requiredFields: ["environment", "approval"], knownFields: ["environment"] }) as any;
  assert.deepEqual(plan.missingFields, ["approval"]);
  const handoff = sessionHandoff({ summary: "done", completed: ["tests"], pending: ["review"], constraints: ["no merge"], evidenceIds: ["run-1"] }) as any;
  assert.equal(handoff.sessionMutated, false);
});
test("retention policy rejects secret storage and never stores by itself", () => {
  const result = memoryRetentionPolicy({ sensitivity: "secret", userApproved: true, hasExpiry: true, containsCredential: false }) as any;
  assert.equal(result.decision, "do-not-store");
  assert.equal(result.storagePerformed, false);
});
test("coverage and source ranking use supplied data only", () => {
  const coverage = coverageGapAnalyzer({ files: [{ path: "a.ts", statements: 10, coveredStatements: 7, testCount: 1 }] }) as any;
  assert.equal(coverage.files[0].uncoveredStatements, 3);
  const ranked = sourceCredibilityRanker({ sources: [{ id: "primary", authority: 0.9, primarySource: true, recent: true, transparent: true }] }) as any;
  assert.equal(ranked.sources[0].verifiedExternally, false);
});
test("research analysis surfaces conflicts instead of choosing truth", () => {
  const claims = [{ topic: "release", sourceId: "a", claim: "ready", evidenceId: "e1" }, { topic: "release", sourceId: "b", claim: "not ready", evidenceId: "e2" }];
  assert.equal((crossSourceSynthesizer({ claims }) as any).unresolvedConflicts, 1);
  assert.equal((factConflictDetector({ claims: claims.map(c => ({ topic: c.topic, sourceId: c.sourceId, value: c.claim })) }) as any).truthDetermined, false);
  assert.equal((researchBriefWriter({ question: "What changed?", sources: [{ id: "a", summary: "Change summary", limitations: [] }] }) as any).unsupportedConclusionsAdded, false);
});
test("scheduled jobs are planned, not created; idempotency keys are stable", () => {
  const job = scheduledJobPlanner({ jobId: "j1", schedule: "0 9 * * *", timezone: "Asia/Bangkok", recurrence: "cron", requiresApproval: true }) as any;
  assert.equal(job.valid, true);
  assert.equal(job.jobCreated, false);
  const first = (idempotencyGuard({ action: "write", scope: "workspace-a", payload: { x: 1 } }) as any).key;
  const second = (idempotencyGuard({ action: "write", scope: "workspace-a", payload: { x: 1 } }) as any).key;
  assert.equal(first, second);
});
test("cost latency and offline evaluation report only supplied evidence", () => {
  const stats = costLatencyAnalyzer({ samples: [{ cost: 0.1, latencyMs: 10, route: "fast" }, { cost: 0.2, latencyMs: 30, route: "slow" }] }) as any;
  assert.equal(stats.sampleCount, 2);
  assert.equal(stats.p95LatencyMs, 30);
  const evalResult = offlineEvaluationRunner({ cases: [{ id: "1", expected: "ok", actual: "ok" }, { id: "2", expected: "yes", actual: "no" }] }) as any;
  assert.equal(evalResult.failed, 1);
  assert.equal(evalResult.promotionAllowed, false);
});
test("rollback advisor never rolls back automatically", () => {
  const result = skillRollbackManager({ skillId: "evolution.10", regressionDetected: true, rollbackAvailable: true, securityIncident: false }) as any;
  assert.equal(result.automaticRollback, false);
  assert.equal(result.recommendation, "request-human-approved-rollback");
});
test("registry only registers verified planning analysis handlers", () => {
  const registry = new AdvancedSkillRegistry();
  assert.deepEqual(registerVerifiedPlanningAnalysisSkills(registry), []);
});
