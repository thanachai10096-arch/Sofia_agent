import assert from "node:assert/strict";
import test from "node:test";

import { TaskEfficiencyMetrics } from "./task-efficiency-metrics.js";

test("records aggregate usage and verified cost per successful task without prompt data", () => {
  const metrics = new TaskEfficiencyMetrics();
  metrics.start(1_000);
  metrics.recordModelCall({
    inputTokens: 100,
    outputTokens: 25,
    cachedInputTokens: 40,
    durationMs: 200,
    retries: 1,
    estimatedCostNanoUsd: 300n,
  });
  metrics.recordModelCall({
    inputTokens: 50,
    outputTokens: 10,
    durationMs: 100,
    estimatedCostNanoUsd: 100n,
  });

  const task = metrics.finishTask({
    taskId: "run-1",
    completed: true,
    acceptanceCriteria: 2,
    passedCriteria: 2,
    now: 1_750,
  });

  assert.equal(task.inputTokens, 150);
  assert.equal(task.outputTokens, 35);
  assert.equal(task.cachedInputTokens, 40);
  assert.equal(task.modelCalls, 2);
  assert.equal(task.retries, 1);
  assert.equal(task.durationMs, 750);
  assert.equal(task.estimatedCostNanoUsd, "400");
  assert.equal(task.costPerVerifiedSuccessNanoUsd, "400");
  assert.equal("prompt" in task, false);

  assert.deepEqual(metrics.snapshot(), {
    taskCount: 1,
    verifiedSuccesses: 1,
    successRate: 1,
    inputTokens: 150,
    outputTokens: 35,
    cachedInputTokens: 40,
    modelCalls: 2,
    unmeasuredModelCalls: 0,
    usageComplete: true,
    retries: 1,
    medianDurationMs: 750,
    p95DurationMs: 750,
    estimatedCostNanoUsd: "400",
    costKnownTasks: 1,
    costPerVerifiedSuccessNanoUsd: "400",
  });
});

test("does not claim verified success when acceptance criteria fail", () => {
  const metrics = new TaskEfficiencyMetrics();
  metrics.start(10);
  metrics.recordModelCall({
    inputTokens: 5,
    outputTokens: 2,
    durationMs: 1,
    estimatedCostNanoUsd: 12n,
  });

  const task = metrics.finishTask({
    taskId: "run-failed",
    completed: false,
    acceptanceCriteria: 2,
    passedCriteria: 1,
    now: 20,
  });

  assert.equal(task.costPerVerifiedSuccessNanoUsd, undefined);
  assert.equal(metrics.snapshot().verifiedSuccesses, 0);
  assert.equal(metrics.snapshot().successRate, 0);
});

test("unknown pricing stays unknown instead of reporting a fabricated total", () => {
  const metrics = new TaskEfficiencyMetrics();
  metrics.start(0);
  metrics.recordModelCall({
    inputTokens: 5,
    outputTokens: 2,
    durationMs: 1,
  });

  const task = metrics.finishTask({
    taskId: "run-unpriced",
    completed: true,
    acceptanceCriteria: 1,
    passedCriteria: 1,
    now: 10,
  });

  assert.equal(task.costKnown, false);
  assert.equal(task.estimatedCostNanoUsd, undefined);
  assert.equal(metrics.snapshot().estimatedCostNanoUsd, null);
  assert.equal(metrics.snapshot().costPerVerifiedSuccessNanoUsd, null);
});

test("rejects invalid usage and criteria without corrupting the active measurement", () => {
  const metrics = new TaskEfficiencyMetrics();
  metrics.start(100);
  assert.throws(
    () => metrics.recordModelCall({
      inputTokens: -1,
      outputTokens: 2,
      durationMs: 1,
    }),
    /Invalid telemetry input tokens/,
  );
  assert.throws(
    () => metrics.finishTask({
      taskId: "bad",
      completed: true,
      acceptanceCriteria: 1,
      passedCriteria: 2,
      now: 200,
    }),
    /Passed criteria exceed acceptance criteria/,
  );

  metrics.recordModelCall({
    inputTokens: 1,
    outputTokens: 1,
    durationMs: 1,
    estimatedCostNanoUsd: 2n,
  });
  assert.equal(metrics.finishTask({
    taskId: "good",
    completed: true,
    acceptanceCriteria: 1,
    passedCriteria: 1,
    now: 200,
  }).inputTokens, 1);
});

test("requires task start before recording model calls", () => {
  const metrics = new TaskEfficiencyMetrics();
  assert.throws(() => metrics.recordModelCall({
    inputTokens: 1,
    outputTokens: 1,
    durationMs: 1,
  }), /Task telemetry has not started/);
});


test("does not report zero cost as known when no model calls were recorded", () => {
  const metrics = new TaskEfficiencyMetrics();
  metrics.start(1);
  const task = metrics.finishTask({
    taskId: "run-no-calls",
    completed: false,
    acceptanceCriteria: 1,
    passedCriteria: 0,
    now: 2,
  });
  assert.equal(task.costKnown, false);
  assert.equal(task.estimatedCostNanoUsd, undefined);
  assert.equal(metrics.snapshot().estimatedCostNanoUsd, null);
});


test("marks usage and cost incomplete when a model call fails before usage is returned", () => {
  const metrics = new TaskEfficiencyMetrics();
  metrics.start(100);
  metrics.recordModelCall({ inputTokens: 20, outputTokens: 5, durationMs: 10, estimatedCostNanoUsd: 100n });
  metrics.recordUnmeasuredModelCall();
  const task = metrics.finishTask({ taskId: "partial-usage", completed: true, acceptanceCriteria: 1, passedCriteria: 1, now: 150 });
  assert.equal(task.modelCalls, 2);
  assert.equal(task.unmeasuredModelCalls, 1);
  assert.equal(task.usageComplete, false);
  assert.equal(task.costKnown, false);
  assert.equal(task.estimatedCostNanoUsd, undefined);
  assert.equal(metrics.snapshot().usageComplete, false);
  assert.equal(metrics.snapshot().unmeasuredModelCalls, 1);
});
