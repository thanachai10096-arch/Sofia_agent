import type { EvaluationCase, EvaluationResult, EvaluationRunner } from "../evaluation.js";
import type { TrajectoryRecorder } from "./trajectory.js";

export interface BatchEvaluationOptions {
  /** Defaults to 1 to avoid concurrent evaluations mutating the same workspace. */
  concurrency?: number;
  maxCases?: number;
}
export interface BatchEvaluationReport {
  startedAt: string;
  completedAt: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  results: EvaluationResult[];
}

/** Bounded, order-preserving batch wrapper around Sofia's existing evidence-based evaluator. */
export class BatchEvaluationRunner {
  constructor(private readonly runner: EvaluationRunner, private readonly trajectory?: TrajectoryRecorder) {}

  async run(cases: readonly EvaluationCase[], options: BatchEvaluationOptions = {}): Promise<BatchEvaluationReport> {
    const maxCases = options.maxCases ?? 500;
    const concurrency = options.concurrency ?? 1;
    if (!Number.isSafeInteger(maxCases) || maxCases < 1 || maxCases > 10_000) throw new Error("maxCases must be an integer between 1 and 10000");
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("concurrency must be an integer between 1 and 16");
    if (cases.length > maxCases) throw new Error("Evaluation batch exceeds configured maxCases");
    const ids = new Set<string>();
    for (const item of cases) {
      if (!item.id.trim()) throw new Error("Evaluation case id must not be empty");
      if (ids.has(item.id)) throw new Error("Duplicate evaluation case id: " + item.id);
      ids.add(item.id);
    }

    const startedAt = new Date().toISOString();
    const results = new Array<EvaluationResult>(cases.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, Math.max(1, cases.length)) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= cases.length) return;
        const testCase = cases[index]!;
        this.trajectory?.record("evaluation.case.started", { caseId: testCase.id, tags: testCase.tags ?? [] });
        let result: EvaluationResult;
        try {
          result = await this.runner.run(testCase);
        } catch (error) {
          result = {
            caseId: testCase.id,
            passed: false,
            score: 0,
            durationMs: 0,
            details: "Evaluation runner threw: " + (error instanceof Error ? error.message : String(error)),
          };
        }
        results[index] = result;
        this.trajectory?.record("evaluation.case.completed", {
          caseId: result.caseId,
          passed: result.passed,
          score: result.score,
          durationMs: result.durationMs,
          details: result.details,
        });
      }
    });
    await Promise.all(workers);
    const completedAt = new Date().toISOString();
    const passed = results.filter((item) => item.passed).length;
    return {
      startedAt,
      completedAt,
      total: results.length,
      passed,
      failed: results.length - passed,
      passRate: results.length ? passed / results.length : 0,
      results,
    };
  }
}
