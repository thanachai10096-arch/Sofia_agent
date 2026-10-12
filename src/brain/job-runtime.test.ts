import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DurableJobRuntime } from "./job-runtime.js";
import type { SofiaBrain } from "./executor.js";

test("DurableJobRuntime marks an interrupted persisted job recoverable after restart", async () => {
  const namespace = "job-runtime-restart-" + randomUUID();
  const hangingBrain = {
    run: () => new Promise(() => undefined),
  } as unknown as SofiaBrain;

  const firstRuntime = new DurableJobRuntime(() => hangingBrain, undefined, namespace);
  const submitted = await firstRuntime.submit({ task: "recover after process restart" });

  // Allow the fire-and-forget execution to persist its running state.
  await new Promise<void>((resolve) => setImmediate(resolve));

  const restartedRuntime = new DurableJobRuntime(() => hangingBrain, undefined, namespace);
  const recovered = await restartedRuntime.get(submitted.id);

  assert.equal(recovered?.status, "failed");
  assert.match(recovered?.error ?? "", /interrupted/i);
});


test("DurableJobRuntime cancels an active run and persists the terminal state", async () => {
  const namespace = "job-runtime-cancel-" + randomUUID();
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const brain = {
    run: async ({ signal }: { signal?: AbortSignal }) => {
      started();
      if (!signal) throw new Error("Runtime did not pass an abort signal");
      if (signal.aborted) return { completed: false, state: "cancelled" };
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { completed: false, state: "cancelled" };
    },
  } as unknown as SofiaBrain;

  const runtime = new DurableJobRuntime(() => brain, undefined, namespace);
  const submitted = await runtime.submit({ task: "cancel an active run" });
  await running;
  assert.equal(await runtime.cancel(submitted.id), true);

  let finalRecord = await runtime.get(submitted.id);
  for (let attempt = 0; attempt < 20 && finalRecord?.status === "running"; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    finalRecord = await runtime.get(submitted.id);
  }
  assert.equal(finalRecord?.status, "cancelled");

  const restartedRuntime = new DurableJobRuntime(() => brain, undefined, namespace);
  assert.equal((await restartedRuntime.get(submitted.id))?.status, "cancelled");
});

test("DurableJobRuntime rejects resume when a job has no saved checkpoint", async () => {
  const namespace = "job-runtime-no-checkpoint-" + randomUUID();
  const brain = {
    run: async () => ({ completed: false, state: "failed" }),
  } as unknown as SofiaBrain;
  const runtime = new DurableJobRuntime(() => brain, undefined, namespace);
  const submitted = await runtime.submit({ task: "no checkpoint available" });

  // submit() starts execution asynchronously; wait until the run has settled before
  // asserting that resume rejects for a missing checkpoint rather than a live run.
  let current = await runtime.get(submitted.id);
  for (let attempt = 0; attempt < 100 && current?.status === "running"; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    current = await runtime.get(submitted.id);
  }
  assert.equal(current?.status, "failed");
  await assert.rejects(() => runtime.resume(submitted.id), /no resumable snapshot/i);
});


test("DurableJobRuntime resumes a saved checkpoint and passes it to the brain", async () => {
  const namespace = "job-runtime-resume-" + randomUUID();
  const { DurableJobRuntime: Runtime } = await import("./job-runtime.js");
  const snapshot = {
    version: 1,
    runId: "resume-run-" + randomUUID(),
    task: "resume checkpoint",
    understanding: {},
    plan: {},
    acceptanceCriteria: [],
    completedStepIds: ["step-1"],
    checkpointId: "checkpoint-1",
    usage: { steps: 1, toolCalls: 0, modelCalls: 1, reservedOrUsedTokens: 0, replans: 0 },
    observations: [],
    diagnoses: [],
    decisions: [],
    recoveryRounds: 0,
    trace: [],
  } as unknown as import("./run-state.js").BrainRunSnapshot;

  let calls = 0;
  let receivedResume: import("./run-state.js").BrainRunSnapshot | undefined;
  const runtime = new Runtime(({ onRunSnapshot }) => ({
    run: async (input: { resume?: import("./run-state.js").BrainRunSnapshot }) => {
      calls += 1;
      if (input.resume) {
        receivedResume = input.resume;
        return { completed: true, state: "completed" };
      }
      await onRunSnapshot?.(snapshot);
      return { completed: false, state: "failed" };
    },
  } as unknown as SofiaBrain), undefined, namespace);

  const submitted = await runtime.submit({ task: "resume checkpoint" });
  let current = await runtime.get(submitted.id);
  for (let attempt = 0; attempt < 100 && current?.status !== "failed"; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    current = await runtime.get(submitted.id);
  }

  assert.equal(current?.status, "failed");
  assert.equal(current?.snapshot?.checkpointId, "checkpoint-1");

  let resumed: Awaited<ReturnType<typeof runtime.resume>> | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      resumed = await runtime.resume(submitted.id);
      break;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Job is already running") throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.ok(resumed, "job execution should release its controller before resume");
  assert.equal(resumed.status, "completed");
  assert.equal(calls, 2);
  assert.equal(receivedResume?.checkpointId, "checkpoint-1");
  assert.equal((await runtime.get(submitted.id))?.status, "completed");
  assert.equal((await runtime.list()).find((item) => item.id === submitted.id)?.status, "completed");
});

test("DurableJobRuntime reserves the resume lock before asynchronous job lookup", async () => {
  const namespace = "job-runtime-resume-lock-" + randomUUID();
  const runtime = new DurableJobRuntime(() => ({
    run: async () => ({ completed: true, state: "completed" }),
  } as unknown as SofiaBrain), undefined, namespace);

  const results = await Promise.allSettled([
    runtime.resume("missing-job"),
    runtime.resume("missing-job"),
  ]);

  assert.equal(results.filter((result) => result.status === "rejected").length, 2);
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
  assert.equal(errors.filter((message) => message === "Unknown job").length, 1);
  assert.equal(errors.filter((message) => message === "Job is already being resumed").length, 1);
});


test("DurableJobRuntime rejects resume for a cancelled job even when a checkpoint exists", async () => {
  const namespace = "job-runtime-cancelled-resume-" + randomUUID();
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const snapshot = {
    version: 1,
    runId: "cancelled-resume-" + randomUUID(),
    task: "cancelled checkpoint",
    understanding: {},
    plan: {},
    acceptanceCriteria: [],
    completedStepIds: [],
    checkpointId: "cancelled-checkpoint",
    usage: { steps: 0, toolCalls: 0, modelCalls: 0, reservedOrUsedTokens: 0, replans: 0 },
    observations: [],
    diagnoses: [],
    decisions: [],
    recoveryRounds: 0,
    trace: [],
  } as unknown as import("./run-state.js").BrainRunSnapshot;

  const brain = {
    run: async ({ signal }: { signal?: AbortSignal }) => {
      started();
      if (!signal) throw new Error("Runtime did not pass an abort signal");
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { completed: false, state: "cancelled" };
    },
  } as unknown as SofiaBrain;
  const runtime = new DurableJobRuntime(({ onRunSnapshot }) => {
    void onRunSnapshot?.(snapshot);
    return brain;
  }, undefined, namespace);

  const submitted = await runtime.submit({ task: "cancelled checkpoint" });
  await running;
  assert.equal(await runtime.cancel(submitted.id), true);
  let current = await runtime.get(submitted.id);
  for (let attempt = 0; attempt < 50 && current?.status !== "cancelled"; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    current = await runtime.get(submitted.id);
  }
  assert.equal(current?.status, "cancelled");
  assert.ok(current?.snapshot, "cancelled job should retain its checkpoint");
  await assert.rejects(() => runtime.resume(submitted.id), /cancelled jobs cannot be resumed/i);
});
