/**
 * Privacy-safe, in-memory task efficiency telemetry.
 *
 * This records aggregate usage and verification outcomes only. It deliberately
 * does not accept or retain prompts, model responses, API keys, or file contents.
 * It is analytics, not a replacement for TokenBudget's authoritative accounting.
 */

export interface ModelCallMeasurement {
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  retries?: number;
  estimatedCostNanoUsd?: bigint;
  cachedInputTokens?: number;
}

export interface TaskMeasurement {
  taskId: string;
  completed: boolean;
  acceptanceCriteria: number;
  passedCriteria: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  modelCalls: number;
  retries: number;
  durationMs: number;
  estimatedCostNanoUsd?: string;
  costKnown: boolean;
  costPerVerifiedSuccessNanoUsd?: string;
}

export interface EfficiencySnapshot {
  taskCount: number;
  verifiedSuccesses: number;
  successRate: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  modelCalls: number;
  retries: number;
  medianDurationMs: number | null;
  p95DurationMs: number | null;
  estimatedCostNanoUsd: string | null;
  costKnownTasks: number;
  costPerVerifiedSuccessNanoUsd: string | null;
}

function validCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid telemetry ${label}`);
  }
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

export class TaskEfficiencyMetrics {
  private readonly calls: ModelCallMeasurement[] = [];
  private readonly completedTasks: TaskMeasurement[] = [];
  private startedAt?: number;

  start(now = Date.now()): void {
    validCount(now, "start timestamp");
    if (this.startedAt !== undefined) throw new Error("Task telemetry already started");
    this.startedAt = now;
  }

  recordModelCall(call: ModelCallMeasurement): void {
    validCount(call.inputTokens, "input tokens");
    validCount(call.outputTokens, "output tokens");
    validCount(call.durationMs, "duration");
    validCount(call.retries ?? 0, "retries");
    validCount(call.cachedInputTokens ?? 0, "cached input tokens");
    if ((call.cachedInputTokens ?? 0) > call.inputTokens) {
      throw new Error("Cached input tokens exceed input tokens");
    }
    if (call.estimatedCostNanoUsd !== undefined &&
        (typeof call.estimatedCostNanoUsd !== "bigint" || call.estimatedCostNanoUsd < 0n)) {
      throw new Error("Invalid estimated cost");
    }
    this.calls.push({ ...call });
  }

  finishTask(input: {
    taskId: string;
    completed: boolean;
    acceptanceCriteria: number;
    passedCriteria: number;
    now?: number;
  }): TaskMeasurement {
    if (!this.startedAt) throw new Error("Task telemetry has not started");
    if (!input.taskId.trim()) throw new Error("Task ID is required");
    validCount(input.acceptanceCriteria, "acceptance criteria");
    validCount(input.passedCriteria, "passed criteria");
    const end = input.now ?? Date.now();
    validCount(end, "finish timestamp");
    if (end < this.startedAt) throw new Error("Finish timestamp precedes start");
    if (input.passedCriteria > input.acceptanceCriteria) {
      throw new Error("Passed criteria exceed acceptance criteria");
    }

    const allCostsKnown = this.calls.every((call) => call.estimatedCostNanoUsd !== undefined);
    const estimatedCost = allCostsKnown
      ? this.calls.reduce((sum, call) => sum + call.estimatedCostNanoUsd!, 0n)
      : undefined;
    const verified = input.completed &&
      input.acceptanceCriteria > 0 &&
      input.passedCriteria === input.acceptanceCriteria;

    const measurement: TaskMeasurement = {
      taskId: input.taskId,
      completed: input.completed,
      acceptanceCriteria: input.acceptanceCriteria,
      passedCriteria: input.passedCriteria,
      inputTokens: this.calls.reduce((sum, call) => sum + call.inputTokens, 0),
      outputTokens: this.calls.reduce((sum, call) => sum + call.outputTokens, 0),
      cachedInputTokens: this.calls.reduce((sum, call) => sum + (call.cachedInputTokens ?? 0), 0),
      modelCalls: this.calls.length,
      retries: this.calls.reduce((sum, call) => sum + (call.retries ?? 0), 0),
      durationMs: end - this.startedAt,
      estimatedCostNanoUsd: estimatedCost?.toString(),
      costKnown: estimatedCost !== undefined,
      costPerVerifiedSuccessNanoUsd: verified && estimatedCost !== undefined
        ? estimatedCost.toString()
        : undefined,
    };

    this.completedTasks.push(measurement);
    this.calls.length = 0;
    this.startedAt = undefined;
    return { ...measurement };
  }

  snapshot(): EfficiencySnapshot {
    const tasks = this.completedTasks;
    const successes = tasks.filter((task) =>
      task.completed &&
      task.acceptanceCriteria > 0 &&
      task.passedCriteria === task.acceptanceCriteria,
    );
    const costsKnown = tasks.filter((task) => task.costKnown);
    const totalKnownCost = costsKnown.reduce(
      (sum, task) => sum + BigInt(task.estimatedCostNanoUsd!),
      0n,
    );
    const successCostsKnown = successes.filter(
      (task) => task.costPerVerifiedSuccessNanoUsd !== undefined,
    );
    const successCost = successCostsKnown.reduce(
      (sum, task) => sum + BigInt(task.costPerVerifiedSuccessNanoUsd!),
      0n,
    );

    return {
      taskCount: tasks.length,
      verifiedSuccesses: successes.length,
      successRate: tasks.length === 0 ? null : successes.length / tasks.length,
      inputTokens: tasks.reduce((sum, task) => sum + task.inputTokens, 0),
      outputTokens: tasks.reduce((sum, task) => sum + task.outputTokens, 0),
      cachedInputTokens: tasks.reduce((sum, task) => sum + task.cachedInputTokens, 0),
      modelCalls: tasks.reduce((sum, task) => sum + task.modelCalls, 0),
      retries: tasks.reduce((sum, task) => sum + task.retries, 0),
      medianDurationMs: percentile(tasks.map((task) => task.durationMs), 0.5),
      p95DurationMs: percentile(tasks.map((task) => task.durationMs), 0.95),
      estimatedCostNanoUsd: costsKnown.length === 0 ? null : totalKnownCost.toString(),
      costKnownTasks: costsKnown.length,
      costPerVerifiedSuccessNanoUsd: successCostsKnown.length === 0
        ? null
        : (successCost / BigInt(successCostsKnown.length)).toString(),
    };
  }
}
