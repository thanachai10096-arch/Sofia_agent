import test from "node:test";
import assert from "node:assert/strict";
import { promptVariantEvaluator, skillPromotionGate, skillRankingEngine, skillSuccessScorer, tokenBudgetPlanner, registerVerifiedEvolutionSkills } from "./evolution-handlers.js";
import { AdvancedSkillRegistry } from "./advanced-skill-runtime.js";

test("success scorer adjusts for small samples and never promotes automatically", () => {
  const result = skillSuccessScorer({ attempts: 10, successes: 9, failures: 1 }) as { successRate: number; sampleConfidence: number; confidenceAdjustedScore: number; autoPromotion: boolean };
  assert.equal(result.successRate, 0.9);
  assert.equal(result.sampleConfidence, 1 / 3);
  assert.equal(result.confidenceAdjustedScore, 0.3);
  assert.equal(result.autoPromotion, false);
});

test("success scorer rejects inconsistent aggregates", () => {
  assert.throws(() => skillSuccessScorer({ attempts: 5, successes: 4, failures: 2 }), /cannot exceed attempts/);
});

test("ranking engine sorts evidence-backed candidates with transparent weights", () => {
  const result = skillRankingEngine({ candidates: [
    { id: "slow", successRate: 0.9, latencyMs: 900, cost: 0.8, evidenceId: "run-1", sampleSize: 30 },
    { id: "fast", successRate: 0.95, latencyMs: 100, cost: 0.2, evidenceId: "run-2", sampleSize: 40 },
  ] }) as { ranked: Array<{ id: string; score: number }>; weights: { success: number; latency: number; cost: number }; mutatesRegistry: boolean };
  assert.equal(result.ranked[0]?.id, "fast");
  assert.ok(
    Math.abs(result.weights.success + result.weights.latency + result.weights.cost - 1) < 1e-12,
    "weights should sum to 1 within floating-point tolerance",
  );
  assert.equal(result.mutatesRegistry, false);
});

test("ranking engine rejects duplicate IDs and missing evidence", () => {
  const candidate = { id: "same", successRate: 0.9, latencyMs: 1, cost: 1, evidenceId: "e-1", sampleSize: 10 };
  assert.throws(() => skillRankingEngine({ candidates: [candidate, candidate] }), /unique/);
  assert.throws(() => skillRankingEngine({ candidates: [{ ...candidate, evidenceId: "" }] }), /evidenceId/);
});

test("budget planner respects token reserve and cost ceiling", () => {
  const result = tokenBudgetPlanner({ tokenLimit: 1000, estimatedTokens: 850, costLimit: 2, estimatedCost: 1.5, reserveRatio: 0.2 }) as { usableTokens: number; allowedByEstimate: boolean; executesWork: boolean };
  assert.equal(result.usableTokens, 800);
  assert.equal(result.allowedByEstimate, false);
  assert.equal(result.executesWork, false);
});

test("budget planner rejects negative or non-finite values", () => {
  assert.throws(() => tokenBudgetPlanner({ tokenLimit: 100, estimatedTokens: -1, costLimit: 2, estimatedCost: 1 }), /estimatedTokens/);
  assert.throws(() => tokenBudgetPlanner({ tokenLimit: 100, estimatedTokens: 1, costLimit: 2, estimatedCost: 1, reserveRatio: 0.9 }), /reserveRatio/);
});

test("verified evolution handlers register through the guarded dispatcher", async () => {
  const registry = new AdvancedSkillRegistry();
  const ids = registerVerifiedEvolutionSkills(registry);
  assert.deepEqual(ids, ["evolution.01", "evolution.03", "evolution.04", "evolution.06", "evolution.09"]);
  assert.ok(ids.every(id => registry.has(id)));
  const result = await registry.execute("evolution.06", {
    tokenLimit: 1000, estimatedTokens: 500, costLimit: 2, estimatedCost: 1,
  }, { principalId: "test-user", signal: new AbortController().signal }) as { allowedByEstimate: boolean };
  assert.equal(result.allowedByEstimate, true);
});

test("prompt variant evaluator excludes safety incidents and never deploys", () => {
  const result = promptVariantEvaluator({ variants: [
    { id: "safe", sampleSize: 20, passRate: 0.9, safetyIncidents: 0, evidenceId: "eval-1" },
    { id: "unsafe", sampleSize: 20, passRate: 1, safetyIncidents: 1, evidenceId: "eval-2" },
  ] }) as { recommendedForHumanReview: { id: string } | null; excludedVariantIds: string[]; deploymentAllowed: boolean };
  assert.equal(result.recommendedForHumanReview?.id, "safe");
  assert.deepEqual(result.excludedVariantIds, ["unsafe"]);
  assert.equal(result.deploymentAllowed, false);
});

test("skill promotion gate requires sufficient evidence and zero safety incidents", () => {
  const eligible = skillPromotionGate({ skillId: "demo.skill", attempts: 40, successes: 39, safetyIncidents: 0, evidenceIds: ["ci-1", "eval-2"] }) as { eligibleForReview: boolean; promotionApplied: boolean };
  const blocked = skillPromotionGate({ skillId: "demo.skill", attempts: 40, successes: 40, safetyIncidents: 1, evidenceIds: ["ci-1"] }) as { eligibleForReview: boolean; promotionApplied: boolean };
  assert.equal(eligible.eligibleForReview, true);
  assert.equal(eligible.promotionApplied, false);
  assert.equal(blocked.eligibleForReview, false);
});

test("skill promotion gate is approval-protected by the dispatcher", async () => {
  const registry = new AdvancedSkillRegistry();
  registerVerifiedEvolutionSkills(registry);
  await assert.rejects(
    registry.execute("evolution.09", { skillId: "demo.skill", attempts: 40, successes: 40, safetyIncidents: 0, evidenceIds: ["ci-1"] }, {
      principalId: "test-user",
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof Error && error.message.includes("Approval required"),
  );
});
