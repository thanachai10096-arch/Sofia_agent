import type { SkillPackage } from "../skills/platform.js";
import type { SkillCandidateEvaluator, SkillEvaluationResult } from "./skill-lifecycle.js";

/**
 * A benchmark fixture is data, not an instruction to execute arbitrary code.
 * The supplied runner is responsible for invoking the candidate in a genuinely
 * isolated workspace/sandbox with the normal Sofia policy gateway.
 */
export interface SkillBenchmarkFixture {
  id: string;
  taskType: string;
  input: string;
  expectedOutcome: string;
}

export interface SkillBenchmarkRun {
  passed: boolean;
  score: number;
  durationMs: number;
  tokensUsed?: number;
}

export interface IsolatedSkillBenchmarkRunner {
  run(input: {
    candidate: SkillPackage;
    fixture: SkillBenchmarkFixture;
    signal: AbortSignal;
  }): Promise<SkillBenchmarkRun>;
}

export interface SkillBenchmarkEvaluatorOptions {
  fixtures: readonly SkillBenchmarkFixture[];
  runner: IsolatedSkillBenchmarkRunner;
  getActiveBaseline?: (skillId: string) => Promise<SkillPackage | undefined> | SkillPackage | undefined;
  minimumPassRate?: number;
  maximumRegression?: number;
  timeoutMs?: number;
  minimumFixtures?: number;
}

function validFixture(fixture: SkillBenchmarkFixture): boolean {
  return Boolean(fixture && typeof fixture.id === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(fixture.id) &&
    typeof fixture.taskType === "string" && fixture.taskType.trim().length > 0 && fixture.taskType.length <= 120 &&
    typeof fixture.input === "string" && fixture.input.trim().length > 0 && fixture.input.length <= 12_000 &&
    typeof fixture.expectedOutcome === "string" && fixture.expectedOutcome.trim().length > 0 && fixture.expectedOutcome.length <= 2_000);
}

function validateRun(value: SkillBenchmarkRun): SkillBenchmarkRun {
  if (!value || typeof value !== "object" || typeof value.passed !== "boolean" ||
      !Number.isFinite(value.score) || value.score < 0 || value.score > 1 ||
      !Number.isFinite(value.durationMs) || value.durationMs < 0 ||
      (value.tokensUsed !== undefined && (!Number.isSafeInteger(value.tokensUsed) || value.tokensUsed < 0))) {
    throw new Error("Benchmark runner returned invalid metrics");
  }
  return value;
}

async function runBounded(
  runner: IsolatedSkillBenchmarkRunner,
  candidate: SkillPackage,
  fixture: SkillBenchmarkFixture,
  timeoutMs: number,
): Promise<SkillBenchmarkRun> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort(new Error("Skill benchmark timed out"));
        reject(new Error("Skill benchmark timed out after " + timeoutMs + "ms"));
      }, timeoutMs);
    });
    const result = await Promise.race([
      runner.run({
        candidate: JSON.parse(JSON.stringify(candidate)) as SkillPackage,
        fixture: { ...fixture },
        signal: controller.signal,
      }),
      timedOut,
    ]);
    return validateRun(result);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Produces evaluation evidence from repeatable task fixtures and, when present,
 * compares the candidate with the currently active version on the same fixtures.
 * The runner must enforce sandboxing; this module never executes skill text.
 */
export function createIsolatedSkillBenchmarkEvaluator(
  options: SkillBenchmarkEvaluatorOptions,
): SkillCandidateEvaluator {
  const minimumPassRate = options.minimumPassRate ?? 1;
  const maximumRegression = options.maximumRegression ?? 0;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const minimumFixtures = options.minimumFixtures ?? 3;
  if (!Number.isFinite(minimumPassRate) || minimumPassRate < 0 || minimumPassRate > 1) {
    throw new Error("minimumPassRate must be between 0 and 1");
  }
  if (!Number.isFinite(maximumRegression) || maximumRegression < 0 || maximumRegression > 1) {
    throw new Error("maximumRegression must be between 0 and 1");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error("timeoutMs must be between 1 and 300000");
  }
  if (!Number.isSafeInteger(minimumFixtures) || minimumFixtures < 1 || minimumFixtures > 100) {
    throw new Error("minimumFixtures must be between 1 and 100");
  }
  const fixtures = options.fixtures.map((fixture) => ({ ...fixture }));
  if (fixtures.length < minimumFixtures || fixtures.length > 100 ||
      !fixtures.every(validFixture) || new Set(fixtures.map((fixture) => fixture.id)).size !== fixtures.length) {
    throw new Error("Benchmark requires unique, valid fixtures and at least minimumFixtures");
  }

  return async (candidate): Promise<SkillEvaluationResult> => {
    const checks: SkillEvaluationResult["checks"] = [];
    const baseline = await options.getActiveBaseline?.(candidate.skill.id);
    if (baseline && baseline.skill?.id !== candidate.skill.id) {
      return {
        passed: false,
        checks: [{
          name: "baseline-identity",
          passed: false,
          detail: "Active baseline skill ID does not match the candidate skill ID.",
        }],
        evaluatedAt: new Date().toISOString(),
      };
    }
    const candidateRuns: SkillBenchmarkRun[] = [];
    const baselineRuns: SkillBenchmarkRun[] = [];
    for (const fixture of fixtures) {
      try {
        const run = await runBounded(options.runner, candidate, fixture, timeoutMs);
        candidateRuns.push(run);
        if (!run.passed) {
          checks.push({
            name: "fixture:" + fixture.id,
            passed: false,
            detail: "Candidate did not satisfy the fixture outcome; score=" + run.score.toFixed(3),
          });
        }
      } catch (error) {
        candidateRuns.push({ passed: false, score: 0, durationMs: timeoutMs });
        checks.push({
          name: "fixture:" + fixture.id,
          passed: false,
          detail: error instanceof Error ? error.message.slice(0, 300) : "Benchmark failed",
        });
      }
    }

    const candidatePassRate = candidateRuns.filter((run) => run.passed).length / fixtures.length;
    const candidateMeanScore = candidateRuns.reduce((sum, run) => sum + run.score, 0) / fixtures.length;
    checks.push({
      name: "candidate-pass-rate",
      passed: candidatePassRate >= minimumPassRate,
      detail: "passRate=" + candidatePassRate.toFixed(3) + "; required=" + minimumPassRate.toFixed(3),
    });

    if (baseline) {
      let baselineFailures = 0;
      for (const fixture of fixtures) {
        try {
          baselineRuns.push(await runBounded(options.runner, baseline, fixture, timeoutMs));
        } catch (error) {
          baselineFailures++;
          baselineRuns.push({ passed: false, score: 0, durationMs: timeoutMs });
        }
      }
      checks.push({
        name: "baseline-evidence",
        passed: baselineFailures === 0,
        detail: baselineFailures === 0
          ? "All active-baseline fixtures produced valid metrics."
          : "Baseline evidence incomplete: " + baselineFailures + " fixture run(s) failed or timed out.",
      });
      const baselinePassRate = baselineRuns.filter((run) => run.passed).length / fixtures.length;
      const baselineMeanScore = baselineRuns.reduce((sum, run) => sum + run.score, 0) / fixtures.length;
      const passRateDelta = candidatePassRate - baselinePassRate;
      const scoreDelta = candidateMeanScore - baselineMeanScore;
      checks.push({
        name: "no-regression-vs-active",
        passed: passRateDelta >= -maximumRegression && scoreDelta >= -maximumRegression,
        detail: "passRateDelta=" + passRateDelta.toFixed(3) + "; scoreDelta=" + scoreDelta.toFixed(3) +
          "; maximumRegression=" + maximumRegression.toFixed(3),
      });
    } else {
      checks.push({
        name: "baseline",
        passed: true,
        detail: "No active version exists; candidate measured against fixtures only.",
      });
    }

    checks.push({
      name: "benchmark-evidence",
      passed: candidateRuns.length === fixtures.length && candidateRuns.every((run) => Number.isFinite(run.score)),
      detail: "fixtures=" + fixtures.length + "; candidateMeanScore=" + candidateMeanScore.toFixed(3) +
        "; baselineRuns=" + baselineRuns.length,
    });
    return { passed: checks.every((check) => check.passed), checks, evaluatedAt: new Date().toISOString() };
  };
}
