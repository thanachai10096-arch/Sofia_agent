import { mkdtemp, rm, readFile } from "node:fs/promises";
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

    await new FileRunStore("test", root).save(snapshot);
    const loaded = await new FileRunStore("test", root).load(snapshot.runId);

    assert.deepEqual(loaded, snapshot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
