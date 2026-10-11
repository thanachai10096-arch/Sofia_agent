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
