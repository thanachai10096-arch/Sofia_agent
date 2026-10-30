import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteSelfImprovementCheckpointStore } from "./sqlite-checkpoint-store.js";
import type { LearningScope } from "./ports.js";

const scope: LearningScope = { tenantId: "tenant-a", principalId: "user-a", projectId: "project-a" };

test("SQLite checkpoint store persists ordered pending events and isolates scopes", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-learning-checkpoint-"));
  const file = path.join(directory, "checkpoint.sqlite");
  try {
    const store = await SqliteSelfImprovementCheckpointStore.open(file);
    await store.write(scope, {
      lastSequence: 4,
      pending: [
        { sequence: 7, receiptId: "receipt-7", summary: "seventh" },
        { sequence: 5, receiptId: "receipt-5", summary: "fifth" },
      ],
    });
    assert.deepEqual(await store.read(scope), {
      lastSequence: 4,
      pending: [
        { sequence: 5, receiptId: "receipt-5", summary: "fifth" },
        { sequence: 7, receiptId: "receipt-7", summary: "seventh" },
      ],
    });
    assert.deepEqual(await store.read({ ...scope, projectId: "project-b" }), { lastSequence: 0, pending: [] });
    store.close();

    const reopened = await SqliteSelfImprovementCheckpointStore.open(file);
    assert.deepEqual(await reopened.read(scope), {
      lastSequence: 4,
      pending: [
        { sequence: 5, receiptId: "receipt-5", summary: "fifth" },
        { sequence: 7, receiptId: "receipt-7", summary: "seventh" },
      ],
    });
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite checkpoint store rejects invalid or duplicate pending sequence numbers", async () => {
  const store = await SqliteSelfImprovementCheckpointStore.open(":memory:");
  try {
    await assert.rejects(store.write(scope, {
      lastSequence: 2,
      pending: [
        { sequence: 3, receiptId: "r3", summary: "three" },
        { sequence: 3, receiptId: "duplicate", summary: "duplicate" },
      ],
    }), /Invalid pending self-improvement notification/);
    await assert.rejects(store.read({ tenantId: "", principalId: "user-a", projectId: "project-a" }), /Invalid authenticated learning scope/);
  } finally {
    store.close();
  }
});
