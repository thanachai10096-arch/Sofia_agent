import type { SkillEvaluationCheck } from "./skill-lifecycle.js";

export interface SkillCapabilityMetrics {
  score: number;
  passRate: number;
  baselineCoverage: number;
  passedChecks: number;
  totalChecks: number;
  baselineChecks: number;
  missingBaselineChecks: string[];
  failedChecks: string[];
}

export interface SkillCapabilityMeasurementInput {
  checks: readonly SkillEvaluationCheck[];
  baseline?: readonly SkillEvaluationCheck[];
}

/**
 * Deterministic capability score for comparing versions of a managed skill.
 * The score combines check pass rate and retention of baseline coverage.
 * It is an observability metric, not a substitute for the promotion safety gate.
 */
export function measureSkillCapability(input: SkillCapabilityMeasurementInput): SkillCapabilityMetrics {
  if (!input || typeof input !== "object" || !Array.isArray(input.checks) || input.checks.length === 0) {
    throw new Error("Capability measurement requires non-empty candidate checks");
  }
  const index = (checks: readonly SkillEvaluationCheck[], label: string): Map<string, boolean> => {
    const result = new Map<string, boolean>();
    for (const check of checks) {
      if (!check || typeof check.name !== "string" || !check.name.trim() ||
          check.name.length > 200 || typeof check.passed !== "boolean") {
        throw new Error(label + " contains a malformed capability check");
      }
      const name = check.name.trim();
      if (result.has(name)) throw new Error(label + " contains duplicate capability check: " + name);
      result.set(name, check.passed);
    }
    return result;
  };
  const candidate = index(input.checks, "Candidate");
  const baseline = input.baseline?.length ? index(input.baseline, "Baseline") : new Map<string, boolean>();
  const passedChecks = [...candidate.values()].filter(Boolean).length;
  const totalChecks = candidate.size;
  const passRate = passedChecks / totalChecks;
  const missingBaselineChecks = [...baseline.keys()].filter((name) => !candidate.has(name));
  const baselineCoverage = baseline.size === 0 ? 1 : (baseline.size - missingBaselineChecks.length) / baseline.size;
  const failedChecks = [...candidate].filter(([, passed]) => !passed).map(([name]) => name);
  const score = Math.round(passRate * baselineCoverage * 10_000) / 100;
  return {
    score,
    passRate: Math.round(passRate * 10_000) / 10_000,
    baselineCoverage: Math.round(baselineCoverage * 10_000) / 10_000,
    passedChecks,
    totalChecks,
    baselineChecks: baseline.size,
    missingBaselineChecks,
    failedChecks,
  };
}
