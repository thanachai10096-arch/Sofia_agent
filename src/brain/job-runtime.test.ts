import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DurableJobRuntime } from "./job-runtime.js";
import type { SofiaBrain } from "./executor.js";
import type { BrainRunSnapshot } from "./run-state.js";
import type { RunStore } from "./run-store.js";

const snapshot: BrainRunSnapshot = {
  version: 1,
  runId: "durable-run-1",
  task: "resume me",
  understanding: { objective: "resume me", constraints: [], assumptions: [], requiredCapabilities: [], requiredTools: [], risk: "low", successCriteria: [], ambiguities: [] },
  plan: { strategy: "initial", reason: "test", steps: [] },
  acceptanceCriteria: [],
  completedStepIds: ["step-1"],
  checkpointId: "checkpoint-1",
  usage: { steps: 1, toolCalls: 1, modelCalls: 1, reservedOrUsedTokens: 10, replans: 0 },
  observations: [],
  diagnoses: [],
  decisions: [],
  recoveryRounds: 0,
  trace: [],
};

test("DurableJobRuntime restores checkpoints and marks orphaned running jobs resumable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-job-runtime-test-"));
  const namespace = "test-" + root;
  const snapshots = new Map<string, BrainRunSnapshot>();
  const store: RunStore = {
    async save(value) { snapshots.set(value.runId, value); },
    async load(id) { return snapshots.get(id); },
    async delete(id) { snapshots.delete(id); },
  };
  let snapshotSaved!: () => void;
  const saved = new Promise<void>((resolve) => { snapshotSaved = resolve; });
  const first = new DurableJobRuntime((options) => ({
    async run() {
      await options.onRunSnapshot?.(snapshot);
      snapshotSaved();
      return await new Promise<never>(() => undefined);
    },
  } as unknown as SofiaBrain), store, namespace);

  try {
    const created = await first.submit({ task: snapshot.task, acceptanceCriteria: [] });
    await saved;

    const restarted = new DurableJobRuntime(() => ({
      async run() { return { completed: true, state: "completed" }; },
    } as unknown as SofiaBrain), store, namespace);
    const jobs = await restarted.list();
    const recovered = jobs.find((job) => job.id === created.id);

    assert.ok(recovered);
    assert.equal(recovered.status, "failed");
    assert.match(recovered.error ?? "", /resume this job from its saved checkpoint/i);
    assert.deepEqual(recovered.snapshot, snapshot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
