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

  await assert.rejects(() => runtime.resume(submitted.id), /no resumable snapshot/i);
});
