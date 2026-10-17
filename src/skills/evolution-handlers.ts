import { getAdvancedSkill } from "./advanced-skill-catalog.js";
import { AdvancedSkillRegistry, type AdvancedSkillHandler } from "./advanced-skill-runtime.js";

type RecordInput = Record<string, unknown>;
function inputRecord(input: unknown): RecordInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Input must be an object.");
  return input as RecordInput;
}
function numberInRange(value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new TypeError(key + " is outside its allowed range.");
  return value;
}
function text(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new TypeError(key + " must be non-empty text up to 200 characters.");
  return value.trim();
}
function list(value: unknown, key: string, max = 100): RecordInput[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new TypeError(key + " must be a bounded array of objects.");
  return value as RecordInput[];
}

/** Calculates a transparent score from caller-supplied run metrics; never promotes automatically. */
export const skillSuccessScorer = (input: unknown) => {
  const value = inputRecord(input);
  const attempts = numberInRange(value.attempts, "attempts", 1, 1_000_000);
  const successes = numberInRange(value.successes, "successes", 0, attempts);
  const failures = numberInRange(value.failures ?? attempts - successes, "failures", 0, attempts);
  if (successes + failures > attempts) throw new RangeError("successes and failures cannot exceed attempts.");
  const rate = successes / attempts;
  const confidence = Math.min(1, attempts / 30);
  return { attempts, successes, failures, successRate: rate, sampleConfidence: confidence, confidenceAdjustedScore: rate * confidence, autoPromotion: false };
};

/** Ranks explicit candidates using visible metrics and normalized caller-selected weights. */
export const skillRankingEngine = (input: unknown) => {
  const value = inputRecord(input);
  const candidates = list(value.candidates, "candidates").map((candidate, index) => ({
    id: text(candidate.id, "candidate id"),
    successRate: numberInRange(candidate.successRate, "successRate", 0, 1),
    latencyMs: numberInRange(candidate.latencyMs, "latencyMs", 0, 86_400_000),
    cost: numberInRange(candidate.cost, "cost", 0, 1_000_000),
    evidenceId: text(candidate.evidenceId, "evidenceId"),
    sampleSize: numberInRange(candidate.sampleSize, "sampleSize", 1, 1_000_000),
    index,
  }));
  if (new Set(candidates.map(candidate => candidate.id)).size !== candidates.length) throw new TypeError("Candidate IDs must be unique.");
  const maxLatency = Math.max(1, ...candidates.map(candidate => candidate.latencyMs));
  const maxCost = Math.max(1, ...candidates.map(candidate => candidate.cost));
  const ranked = candidates.map(candidate => ({
    ...candidate,
    score: 0.7 * candidate.successRate + 0.2 * (1 - candidate.latencyMs / maxLatency) + 0.1 * (1 - candidate.cost / maxCost),
  })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map(({ index: _index, ...candidate }) => candidate);
  return { ranked, weights: { success: 0.7, latency: 0.2, cost: 0.1 }, mutatesRegistry: false };
};

/** Estimates budget fit from caller-supplied estimates; does not execute the planned work. */
export const tokenBudgetPlanner = (input: unknown) => {
  const value = inputRecord(input);
  const tokenLimit = numberInRange(value.tokenLimit, "tokenLimit", 1, 100_000_000);
  const estimatedTokens = numberInRange(value.estimatedTokens, "estimatedTokens", 0, 100_000_000);
  const costLimit = numberInRange(value.costLimit, "costLimit", 0, 1_000_000_000);
  const estimatedCost = numberInRange(value.estimatedCost, "estimatedCost", 0, 1_000_000_000);
  const reserveRatio = numberInRange(value.reserveRatio ?? 0.1, "reserveRatio", 0, 0.5);
  const usableTokens = Math.floor(tokenLimit * (1 - reserveRatio));
  const fitsTokens = estimatedTokens <= usableTokens;
  const fitsCost = estimatedCost <= costLimit;
  return { tokenLimit, estimatedTokens, usableTokens, reserveRatio, fitsTokens, costLimit, estimatedCost, fitsCost, allowedByEstimate: fitsTokens && fitsCost, recommendation: fitsTokens && fitsCost ? "within-budget" : "reduce-scope-or-request-approved-budget", executesWork: false };
};

/** Compares supplied variant evaluations; a recommendation never deploys a prompt. */
export const promptVariantEvaluator = (input: unknown) => {
  const value = inputRecord(input);
  const variants = list(value.variants, "variants", 50).map((variant) => {
    const id = text(variant.id, "variant id");
    const sampleSize = numberInRange(variant.sampleSize, "sampleSize", 1, 1_000_000);
    const passRate = numberInRange(variant.passRate, "passRate", 0, 1);
    const safetyIncidents = numberInRange(variant.safetyIncidents ?? 0, "safetyIncidents", 0, sampleSize);
    const evidenceId = text(variant.evidenceId, "evidenceId");
    return { id, sampleSize, passRate, safetyIncidents, evidenceId };
  });
  if (variants.length === 0 || new Set(variants.map(item => item.id)).size !== variants.length) throw new TypeError("Provide unique prompt variant IDs.");
  const safe = variants.filter(item => item.safetyIncidents === 0).sort((a, b) => b.passRate - a.passRate || b.sampleSize - a.sampleSize);
  return { variants: [...variants].sort((a, b) => b.passRate - a.passRate), recommendedForHumanReview: safe[0] ?? null, excludedVariantIds: variants.filter(item => item.safetyIncidents > 0).map(item => item.id), deploymentAllowed: false };
};

/** Eligibility only. The registry requires trusted approval before this handler can run. */
export const skillPromotionGate: AdvancedSkillHandler = (input) => {
  const value = inputRecord(input);
  const skillId = text(value.skillId, "skillId");
  const attempts = numberInRange(value.attempts, "attempts", 0, 1_000_000);
  const successes = numberInRange(value.successes, "successes", 0, attempts);
  const safetyIncidents = numberInRange(value.safetyIncidents, "safetyIncidents", 0, attempts);
  if (!Array.isArray(value.evidenceIds) || value.evidenceIds.length === 0 || value.evidenceIds.length > 100 || value.evidenceIds.some(item => typeof item !== "string" || !item.trim())) throw new TypeError("evidenceIds must contain 1 to 100 non-empty evidence IDs.");
  const minimumAttempts = numberInRange(value.minimumAttempts ?? 30, "minimumAttempts", 1, 1_000_000);
  const minimumSuccessRate = numberInRange(value.minimumSuccessRate ?? 0.95, "minimumSuccessRate", 0, 1);
  const successRate = attempts === 0 ? 0 : successes / attempts;
  const eligible = attempts >= minimumAttempts && successRate >= minimumSuccessRate && safetyIncidents === 0;
  return { skillId, attempts, successes, successRate, safetyIncidents, evidenceIds: [...new Set(value.evidenceIds as string[])], eligibleForReview: eligible, promotionApplied: false, decision: eligible ? "eligible-for-human-review" : "not-eligible" };
};

export function registerVerifiedEvolutionSkills(registry: AdvancedSkillRegistry): string[] {
  const entries: Array<{ id: string; handler: AdvancedSkillHandler }> = [
    { id: "evolution.01", handler: skillSuccessScorer },
    { id: "evolution.03", handler: skillRankingEngine },
    { id: "evolution.04", handler: promptVariantEvaluator },
    { id: "evolution.06", handler: tokenBudgetPlanner },
    { id: "evolution.09", handler: skillPromotionGate },
  ];
  const registered: string[] = [];
  for (const entry of entries) {
    const definition = getAdvancedSkill(entry.id);
    if (definition?.status === "verified") {
      registry.register(definition, entry.handler);
      registered.push(entry.id);
    }
  }
  return registered;
}
