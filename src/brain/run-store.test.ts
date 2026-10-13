import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { FileRunStore } from "./run-store.js";

test("FileRunStore survives a new store instance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-run-store-test-"));
  try {
    const snapshot = {
      version: 1 as const,
      runId: "run-test-1",
      task: "test",
      understanding: { objective: "test", constraints: [], assumptions: [], requiredCapabilities: [], requiredTools: [], risk: "low" as const, successCriteria: [], ambiguities: [] },
      plan: { strategy: "initial" as const, reason: "test", steps: [] },
      acceptanceCriteria: [],
      completedStepIds: [],
      checkpointId: "checkpoint-1",
      usage: { steps: 1, toolCalls: 0, modelCalls: 0, reservedOrUsedTokens: 0, replans: 0 },
      observations: [],
      diagnoses: [],
      decisions: [],
      recoveryRounds: 0,
      trace: [],
    };

    const store = new FileRunStore("test", root);
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      store.save({ ...snapshot, checkpointId: `checkpoint-${index}` }),
    ));
    const loaded = await stores[0]!.load(snapshot.runId);

    assert.ok(loaded);
    assert.match(loaded.checkpointId, /^checkpoint-(?:[0-9]|1[0-9])$/);
    assert.equal(loaded.runId, snapshot.runId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
