import test from "node:test";
import assert from "node:assert/strict";
import { skillRankingEngine, skillSuccessScorer, tokenBudgetPlanner, registerVerifiedEvolutionSkills } from "./evolution-handlers.js";
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
  assert.equal(result.weights.success + result.weights.latency + result.weights.cost, 1);
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

test("evolution handlers only register after catalog promotion to verified", () => {
  const registry = new AdvancedSkillRegistry();
  assert.deepEqual(registerVerifiedEvolutionSkills(registry), []);
  assert.equal(registry.has("evolution.01"), false);
});
