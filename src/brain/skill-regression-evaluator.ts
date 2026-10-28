import type { SkillPackage } from "../skills/platform.js";
import type { SkillCandidateEvaluator, SkillEvaluationCheck, SkillEvaluationResult } from "./skill-lifecycle.js";

/**
 * A fixed, trusted task used to compare a proposed skill with the behavior Sofia
 * would use without that candidate (or with the currently active version).
 * Keep fixture inputs synthetic and free of credentials or user data.
 */
export interface SkillRegressionFixture {
  id: string;
  taskType: string;
  input: unknown;
}

export interface SkillRegressionOutcome {
  passed: boolean;
  /** Normalized task quality in [0, 1], when the harness can measure it. */
  score?: number;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  detail?: string;
}

export interface SkillRegressionRunRequest {
  mode: "candidate" | "baseline";
  /** Undefined for the control/baseline behavior when no prior skill exists. */
  skill?: SkillPackage;
  fixture: SkillRegressionFixture;
}

export interface SkillRegressionEvaluatorOptions {
  fixtures: readonly SkillRegressionFixture[];
  /**
   * The host MUST implement this callback with a disposable/isolated workspace,
   * bounded runtime, and no ambient secrets. This module never executes skill
   * procedure text itself.
   */
  runCase: (request: SkillRegressionRunRequest) => Promise<SkillRegressionOutcome>;
  /** Return the currently active version, or undefined for the default behavior. */
  baselineForSkill?: (skillId: string) => SkillPackage | undefined;
  minimumPassRate?: number;
  maxLatencyRegressionRatio?: number;
  maxTokenRegressionRatio?: number;
  minimumScoreDelta?: number;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validOutcome(value: unknown): value is SkillRegressionOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.passed === "boolean" &&
    (item.score === undefined || (finiteNonNegative(item.score) && item.score <= 1)) &&
    (item.latencyMs === undefined || finiteNonNegative(item.latencyMs)) &&
    (item.inputTokens === undefined || finiteNonNegative(item.inputTokens)) &&
    (item.outputTokens === undefined || finiteNonNegative(item.outputTokens)) &&
    (item.detail === undefined || typeof item.detail === "string");
}

function ratioRegressed(candidate: number | undefined, baseline: number | undefined, maxRatio: number): boolean {
  if (candidate === undefined || baseline === undefined) return false;
  // Avoid treating a zero baseline as permission for unlimited regressions.
  if (baseline === 0) return candidate > 0;
  return candidate / baseline > maxRatio;
}

/**
 * Build an evaluator for VersionedSkillLifecycle that requires repeatable,
 * baseline-compared fixture evidence. Missing fixtures, malformed outcomes,
 * runner exceptions, failed cases, and measurable regressions fail closed.
 */
export function createSkillRegressionEvaluator(options: SkillRegressionEvaluatorOptions): SkillCandidateEvaluator {
  const fixtures = [...options.fixtures];
  const minimumPassRate = options.minimumPassRate ?? 1;
  const maxLatencyRegressionRatio = options.maxLatencyRegressionRatio ?? 1.5;
  const maxTokenRegressionRatio = options.maxTokenRegressionRatio ?? 1.5;
  const minimumScoreDelta = options.minimumScoreDelta ?? 0;

  if (!Number.isFinite(minimumPassRate) || minimumPassRate <= 0 || minimumPassRate > 1) {
    throw new Error("minimumPassRate must be greater than 0 and at most 1");
  }
  if (!Number.isFinite(maxLatencyRegressionRatio) || maxLatencyRegressionRatio < 1 ||
      !Number.isFinite(maxTokenRegressionRatio) || maxTokenRegressionRatio < 1) {
    throw new Error("Regression ratios must be finite and at least 1");
  }
  if (!Number.isFinite(minimumScoreDelta) || minimumScoreDelta < 0 || minimumScoreDelta > 1) {
    throw new Error("minimumScoreDelta must be between 0 and 1");
  }

  return async (candidate): Promise<SkillEvaluationResult> => {
    const checks: SkillEvaluationCheck[] = [];
    const seen = new Set<string>();
    const usableFixtures = fixtures.filter((fixture) => {
      const valid = Boolean(fixture && typeof fixture.id === "string" && fixture.id.trim() &&
        fixture.id.length <= 200 && typeof fixture.taskType === "string" &&
        fixture.taskType.trim() && fixture.taskType.length <= 100);
      if (!valid || seen.has(fixture.id)) return false;
      seen.add(fixture.id);
      return true;
    });

    checks.push({
      name: "fixture-suite",
      passed: fixtures.length > 0 && usableFixtures.length === fixtures.length,
      detail: fixtures.length === 0
        ? "No regression fixtures configured"
        : usableFixtures.length !== fixtures.length
          ? "Fixtures must have unique non-empty IDs and bounded task types"
          : `${usableFixtures.length} unique fixtures configured`,
    });
    if (usableFixtures.length === 0 || usableFixtures.length !== fixtures.length) {
      return { passed: false, checks, evaluatedAt: new Date().toISOString() };
    }

    const baseline = options.baselineForSkill?.(candidate.skill.id);
    let candidatePasses = 0;
    for (const fixture of usableFixtures) {
      let baselineOutcome: SkillRegressionOutcome | undefined;
      let candidateOutcome: SkillRegressionOutcome | undefined;
      let baselineError = "";
      let candidateError = "";

      try {
        const value: unknown = await options.runCase({ mode: "baseline", ...(baseline ? { skill: baseline } : {}), fixture });
        if (!validOutcome(value)) throw new Error("Harness returned malformed baseline metrics");
        baselineOutcome = value;
      } catch (error) {
        baselineError = error instanceof Error ? error.message : String(error);
      }

      try {
        const value: unknown = await options.runCase({ mode: "candidate", skill: candidate, fixture });
        if (!validOutcome(value)) throw new Error("Harness returned malformed candidate metrics");
        candidateOutcome = value;
      } catch (error) {
        candidateError = error instanceof Error ? error.message : String(error);
      }

      const safeId = fixture.id.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 120);
      checks.push({
        name: `baseline:${safeId}`,
        passed: Boolean(baselineOutcome) && !baselineError,
        detail: baselineError || (baselineOutcome ? `passed=${baselineOutcome.passed}` : "No baseline outcome"),
      });
      const candidatePassed = Boolean(candidateOutcome?.passed) && !candidateError;
      if (candidatePassed) candidatePasses++;
      checks.push({
        name: `candidate:${safeId}`,
        passed: candidatePassed,
        detail: candidateError || (candidateOutcome?.detail ?? `passed=${candidatePassed}`),
      });

      if (baselineOutcome && candidateOutcome) {
        const baselineScore = baselineOutcome.score ?? (baselineOutcome.passed ? 1 : 0);
        const candidateScore = candidateOutcome.score ?? (candidateOutcome.passed ? 1 : 0);
        checks.push({
          name: `quality-regression:${safeId}`,
          passed: candidateScore + minimumScoreDelta >= baselineScore,
          detail: `baseline=${baselineScore}; candidate=${candidateScore}; requiredDelta=${minimumScoreDelta}`,
        });
        checks.push({
          name: `latency-regression:${safeId}`,
          passed: !ratioRegressed(candidateOutcome.latencyMs, baselineOutcome.latencyMs, maxLatencyRegressionRatio),
          detail: `baselineMs=${baselineOutcome.latencyMs ?? "unknown"}; candidateMs=${candidateOutcome.latencyMs ?? "unknown"}; maxRatio=${maxLatencyRegressionRatio}`,
        });
        const baselineTokens = baselineOutcome.inputTokens === undefined && baselineOutcome.outputTokens === undefined
          ? undefined : (baselineOutcome.inputTokens ?? 0) + (baselineOutcome.outputTokens ?? 0);
        const candidateTokens = candidateOutcome.inputTokens === undefined && candidateOutcome.outputTokens === undefined
          ? undefined : (candidateOutcome.inputTokens ?? 0) + (candidateOutcome.outputTokens ?? 0);
        checks.push({
          name: `token-regression:${safeId}`,
          passed: !ratioRegressed(candidateTokens, baselineTokens, maxTokenRegressionRatio),
          detail: `baselineTokens=${baselineTokens ?? "unknown"}; candidateTokens=${candidateTokens ?? "unknown"}; maxRatio=${maxTokenRegressionRatio}`,
        });
      }
    }

    const passRate = candidatePasses / usableFixtures.length;
    checks.push({
      name: "minimum-pass-rate",
      passed: passRate >= minimumPassRate,
      detail: `candidatePassRate=${passRate.toFixed(3)}; minimum=${minimumPassRate.toFixed(3)}`,
    });
    return {
      passed: checks.every((check) => check.passed),
      checks,
      evaluatedAt: new Date().toISOString(),
    };
  };
}
