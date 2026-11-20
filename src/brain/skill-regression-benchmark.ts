/**
 * Deterministic before/after benchmark for skill evaluations.
 *
 * A candidate may not silently drop a baseline check, introduce a failing check,
 * or turn a previously passing check into a failure. Failed baseline checks may
 * remain unchanged or improve, but a candidate must pass every check to pass.
 */
export interface SkillBenchmarkCheck {
  name: string;
  passed: boolean;
}

export interface SkillRegressionBenchmarkInput {
  baseline: readonly SkillBenchmarkCheck[];
  candidate: readonly SkillBenchmarkCheck[];
}

export interface SkillRegressionBenchmarkResult {
  passed: boolean;
  baselineCount: number;
  candidateCount: number;
  regressions: string[];
  improvements: string[];
  unchanged: string[];
  added: string[];
}

function indexChecks(checks: readonly SkillBenchmarkCheck[], label: string): Map<string, boolean> {
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new Error(label + " benchmark checks must be a non-empty array");
  }
  const indexed = new Map<string, boolean>();
  for (const check of checks) {
    if (!check || typeof check.name !== "string" || !check.name.trim() ||
        check.name.length > 200 || typeof check.passed !== "boolean") {
      throw new Error(label + " benchmark contains a malformed check");
    }
    const name = check.name.trim();
    if (indexed.has(name)) throw new Error(label + " benchmark contains duplicate check: " + name);
    indexed.set(name, check.passed);
  }
  return indexed;
}

/**
 * Compares stable check identities, not array positions. Missing baseline checks
 * count as regressions because silently reducing coverage must never look like a pass.
 */
export function compareSkillRegressionBenchmark(
  input: SkillRegressionBenchmarkInput,
): SkillRegressionBenchmarkResult {
  if (!input || typeof input !== "object") {
    throw new Error("Benchmark input must be an object");
  }
  const baseline = indexChecks(input.baseline, "Baseline");
  const candidate = indexChecks(input.candidate, "Candidate");
  const regressions: string[] = [];
  const improvements: string[] = [];
  const unchanged: string[] = [];
  const added: string[] = [];

  for (const [name, baselinePassed] of baseline) {
    if (!candidate.has(name)) {
      regressions.push(name + ":missing");
      continue;
    }
    const candidatePassed = candidate.get(name) === true;
    if (baselinePassed && !candidatePassed) regressions.push(name + ":failed");
    else if (!baselinePassed && candidatePassed) improvements.push(name);
    else unchanged.push(name);
  }

  for (const [name, passed] of candidate) {
    if (baseline.has(name)) continue;
    added.push(name);
    if (!passed) regressions.push(name + ":new-check-failed");
  }

  const candidateFullyPassing = [...candidate.values()].every((passed) => passed);
  return {
    passed: regressions.length === 0 && candidateFullyPassing,
    baselineCount: baseline.size,
    candidateCount: candidate.size,
    regressions,
    improvements,
    unchanged,
    added,
  };
}
