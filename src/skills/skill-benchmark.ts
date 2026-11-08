/**
 * Deterministic benchmark comparison for verified Sofia skills.
 *
 * This module evaluates evidence produced by an isolated, side-effect-free
 * benchmark harness. It never invokes skill handlers, tools, or approvals.
 * Callers must not feed ordinary user-task outcomes into this API.
 * Only aggregate metadata is retained; raw inputs and outputs are excluded.
 */

export interface SkillBenchmarkCaseResult {
  readonly fixtureId: string;
  readonly passed: boolean;
  readonly safetyPassed: boolean;
  readonly durationMs: number;
  readonly toolCalls: number;
  readonly retries: number;
}

export interface SkillBenchmarkReport {
  readonly skillId: string;
  readonly version: string;
  readonly fixtureIds: readonly string[];
  readonly fixtureCount: number;
  readonly passed: number;
  readonly safetyFailures: number;
  readonly passRate: number;
  readonly medianDurationMs: number;
  readonly medianToolCalls: number;
  readonly medianRetries: number;
  readonly completedAt: string;
}

export type SkillBenchmarkVerdict =
  | "insufficient_evidence"
  | "blocked_safety"
  | "regression"
  | "stable"
  | "improved";

export interface SkillBenchmarkComparison {
  readonly verdict: SkillBenchmarkVerdict;
  readonly comparableFixtures: number;
  readonly qualityDelta: number;
  readonly safetyFailureDelta: number;
  readonly durationRatio?: number;
  readonly toolCallRatio?: number;
  readonly reasons: readonly string[];
}

export interface SkillBenchmarkPolicy {
  readonly minFixtures: number;
  readonly maxFixtures: number;
  readonly maxQualityRegression: number;
}

const DEFAULT_POLICY: SkillBenchmarkPolicy = Object.freeze({
  minFixtures: 3,
  maxFixtures: 64,
  maxQualityRegression: 0.02,
});

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function validMetric(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function ratio(current: number, baseline: number): number | undefined {
  return baseline > 0 ? current / baseline : undefined;
}

function validateIdentity(skillId: string, version: string): void {
  if (!skillId.trim() || skillId.length > 160) throw new TypeError("skillId must be 1-160 characters");
  if (!version.trim() || version.length > 80) throw new TypeError("version must be 1-80 characters");
}

function validateResults(
  results: readonly SkillBenchmarkCaseResult[],
  policy: SkillBenchmarkPolicy,
): void {
  if (!Array.isArray(results) || results.length > policy.maxFixtures) {
    throw new RangeError(`Benchmark must contain at most ${policy.maxFixtures} fixtures`);
  }
  const seen = new Set<string>();
  for (const result of results) {
    if (!result.fixtureId.trim() || result.fixtureId.length > 160) {
      throw new TypeError("fixtureId must be 1-160 characters");
    }
    if (seen.has(result.fixtureId)) throw new TypeError(`Duplicate benchmark fixture: ${result.fixtureId}`);
    seen.add(result.fixtureId);
    if (typeof result.passed !== "boolean" || typeof result.safetyPassed !== "boolean") {
      throw new TypeError("Benchmark pass and safety results must be boolean");
    }
    if (!validMetric(result.durationMs) || !validMetric(result.toolCalls) || !validMetric(result.retries)) {
      throw new TypeError("Benchmark metrics must be finite non-negative numbers");
    }
    if (!Number.isSafeInteger(result.toolCalls) || !Number.isSafeInteger(result.retries)) {
      throw new TypeError("toolCalls and retries must be non-negative integers");
    }
  }
}

export class SkillBenchmarkEngine {
  private readonly policy: SkillBenchmarkPolicy;
  private readonly baselines = new Map<string, SkillBenchmarkReport>();

  constructor(policy: Partial<SkillBenchmarkPolicy> = {}) {
    this.policy = Object.freeze({ ...DEFAULT_POLICY, ...policy });
    if (
      !Number.isSafeInteger(this.policy.minFixtures) || this.policy.minFixtures < 1 ||
      !Number.isSafeInteger(this.policy.maxFixtures) || this.policy.maxFixtures < this.policy.minFixtures ||
      !Number.isFinite(this.policy.maxQualityRegression) ||
      this.policy.maxQualityRegression < 0 || this.policy.maxQualityRegression > 1
    ) {
      throw new RangeError("Invalid skill benchmark policy");
    }
  }

  summarize(
    skillId: string,
    version: string,
    results: readonly SkillBenchmarkCaseResult[],
  ): SkillBenchmarkReport {
    validateIdentity(skillId, version);
    validateResults(results, this.policy);
    if (results.length < this.policy.minFixtures) {
      throw new RangeError(`At least ${this.policy.minFixtures} benchmark fixtures are required`);
    }
    const ordered = [...results].sort((a, b) => a.fixtureId.localeCompare(b.fixtureId));
    const passed = ordered.filter((result) => result.passed && result.safetyPassed).length;
    return Object.freeze({
      skillId,
      version,
      fixtureIds: Object.freeze(ordered.map((result) => result.fixtureId)),
      fixtureCount: ordered.length,
      passed,
      safetyFailures: ordered.filter((result) => !result.safetyPassed).length,
      passRate: passed / ordered.length,
      medianDurationMs: median(ordered.map((result) => result.durationMs)),
      medianToolCalls: median(ordered.map((result) => result.toolCalls)),
      medianRetries: median(ordered.map((result) => result.retries)),
      completedAt: new Date().toISOString(),
    });
  }

  /**
   * Set a baseline explicitly after a trusted benchmark run. A safety failure
   * or incomplete fixture set can never become a baseline.
   */
  setBaseline(report: SkillBenchmarkReport): void {
    validateIdentity(report.skillId, report.version);
    if (
      report.fixtureCount < this.policy.minFixtures ||
      report.fixtureCount > this.policy.maxFixtures ||
      report.fixtureIds.length !== report.fixtureCount ||
      new Set(report.fixtureIds).size !== report.fixtureCount ||
      report.safetyFailures !== 0 ||
      !Number.isFinite(report.passRate) || report.passRate < 0 || report.passRate > 1
    ) {
      throw new Error("Only complete, safety-clean benchmark reports can become baselines");
    }
    const key = this.key(report.skillId, report.version);
    this.baselines.set(key, Object.freeze({
      ...report,
      fixtureIds: Object.freeze([...report.fixtureIds].sort()),
    }));
  }

  compare(current: SkillBenchmarkReport): SkillBenchmarkComparison {
    validateIdentity(current.skillId, current.version);
    const baseline = this.baselines.get(this.key(current.skillId, current.version));
    if (!baseline) {
      return {
        verdict: "insufficient_evidence",
        comparableFixtures: 0,
        qualityDelta: 0,
        safetyFailureDelta: current.safetyFailures,
        reasons: ["No baseline exists for this exact skill version"],
      };
    }
    const sameFixtures = baseline.fixtureIds.length === current.fixtureIds.length &&
      baseline.fixtureIds.every((id, index) => id === [...current.fixtureIds].sort()[index]);
    const comparableFixtures = sameFixtures
      ? Math.min(baseline.fixtureCount, current.fixtureCount)
      : 0;
    const qualityDelta = current.passRate - baseline.passRate;
    const safetyFailureDelta = current.safetyFailures - baseline.safetyFailures;
    const durationRatio = ratio(current.medianDurationMs, baseline.medianDurationMs);
    const toolCallRatio = ratio(current.medianToolCalls, baseline.medianToolCalls);

    if (!sameFixtures || comparableFixtures < this.policy.minFixtures) {
      return {
        verdict: "insufficient_evidence",
        comparableFixtures,
        qualityDelta,
        safetyFailureDelta,
        ...(durationRatio !== undefined ? { durationRatio } : {}),
        ...(toolCallRatio !== undefined ? { toolCallRatio } : {}),
        reasons: ["Current run does not use the exact baseline fixture set"],
      };
    }
    if (current.safetyFailures > 0 || safetyFailureDelta > 0) {
      return {
        verdict: "blocked_safety",
        comparableFixtures,
        qualityDelta,
        safetyFailureDelta,
        ...(durationRatio !== undefined ? { durationRatio } : {}),
        ...(toolCallRatio !== undefined ? { toolCallRatio } : {}),
        reasons: ["A benchmark safety gate failed; speed and quality cannot offset it"],
      };
    }
    if (qualityDelta < -this.policy.maxQualityRegression) {
      return {
        verdict: "regression",
        comparableFixtures,
        qualityDelta,
        safetyFailureDelta,
        ...(durationRatio !== undefined ? { durationRatio } : {}),
        ...(toolCallRatio !== undefined ? { toolCallRatio } : {}),
        reasons: ["Correctness fell beyond the configured regression tolerance"],
      };
    }
    return {
      verdict: qualityDelta > 0 ? "improved" : "stable",
      comparableFixtures,
      qualityDelta,
      safetyFailureDelta,
      ...(durationRatio !== undefined ? { durationRatio } : {}),
      ...(toolCallRatio !== undefined ? { toolCallRatio } : {}),
      reasons: qualityDelta > 0
        ? ["Correctness improved with all safety gates passing"]
        : ["No material correctness regression; efficiency is reported separately"],
    };
  }

  getBaseline(skillId: string, version: string): SkillBenchmarkReport | undefined {
    const baseline = this.baselines.get(this.key(skillId, version));
    return baseline ? { ...baseline, fixtureIds: [...baseline.fixtureIds] } : undefined;
  }

  private key(skillId: string, version: string): string {
    return `${skillId.length}:${skillId}${version}`;
  }
}
