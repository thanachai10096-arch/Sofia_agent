import { mkdtemp, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { FileRunStore } from "./run-store.js";

test("FileRunStore serializes concurrent writes across store instances", async () => {
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

    const stores = Array.from({ length: 4 }, () => new FileRunStore("test", root));
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      stores[index % stores.length]!.save({ ...snapshot, checkpointId: `checkpoint-${index}` }),
    ));
    const loaded = await stores[0]!.load(snapshot.runId);

    assert.ok(loaded);
    assert.match(loaded.checkpointId, /^checkpoint-(?:[0-9]|1[0-9])$/);
    assert.equal(loaded.runId, snapshot.runId);
    assert.ok(!JSON.stringify(loaded).includes(secret), "persisted snapshots must redact credential-shaped values");

    if (process.platform !== "win32") {
      const privateDirectory = path.join(root, createHash("sha256").update("test").digest("hex"));
      const snapshotFile = path.join(privateDirectory, createHash("sha256").update(snapshot.runId).digest("hex") + ".json");
      assert.equal((await stat(privateDirectory)).mode & 0o777, 0o700, "snapshot directory must be owner-only");
      assert.equal((await stat(snapshotFile)).mode & 0o777, 0o600, "snapshot file must be owner-readable/writable only");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
