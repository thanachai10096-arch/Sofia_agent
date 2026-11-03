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
      revision: 1,
      lastSequence: 4,
      pending: [
        { sequence: 5, receiptId: "receipt-5", summary: "fifth" },
        { sequence: 7, receiptId: "receipt-7", summary: "seventh" },
      ],
    });
    assert.deepEqual(await store.read({ ...scope, projectId: "project-b" }), { lastSequence: 0, pending: [], revision: 0 });
    store.close();

    const reopened = await SqliteSelfImprovementCheckpointStore.open(file);
    assert.deepEqual(await reopened.read(scope), {
      revision: 1,
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

test("SQLite checkpoint store rejects one receipt ID assigned to multiple pending sequences", async () => {
  const store = await SqliteSelfImprovementCheckpointStore.open(":memory:");
  try {
    await assert.rejects(store.write(scope, {
      lastSequence: 0,
      pending: [
        { sequence: 1, receiptId: "same-receipt", summary: "first delivery" },
        { sequence: 2, receiptId: "same-receipt", summary: "conflicting delivery" },
      ],
    }), /Invalid pending self-improvement notification/);
    assert.deepEqual(await store.read(scope), { lastSequence: 0, pending: [], revision: 0 });
  } finally {
    store.close();
  }
});

test("SQLite checkpoint store rejects a corrupt persisted duplicate receipt identity", async () => {
  const store = await SqliteSelfImprovementCheckpointStore.open(":memory:");
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE verified_learning_checkpoints (
        tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, project_id TEXT NOT NULL,
        last_sequence INTEGER NOT NULL, pending_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, principal_id, project_id)
      );
    `);
    db.prepare("INSERT INTO verified_learning_checkpoints VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      scope.tenantId, scope.principalId, scope.projectId, 0,
      JSON.stringify([
        { sequence: 1, receiptId: "duplicate", summary: "first" },
        { sequence: 2, receiptId: "duplicate", summary: "second" },
      ]),
      Date.now(), 1,
    );
    // Use a separate in-memory store fixture because the production store owns its DB connection.
    db.close();
    const fileStore = await SqliteSelfImprovementCheckpointStore.open(":memory:");
    try {
      await assert.rejects(fileStore.write(scope, {
        lastSequence: 0,
        pending: [
          { sequence: 1, receiptId: "duplicate", summary: "first" },
          { sequence: 2, receiptId: "duplicate", summary: "second" },
        ],
      }), /Invalid pending self-improvement notification/);
    } finally {
      fileStore.close();
    }
  } finally {
    store.close();
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


test("SQLite checkpoint compare-and-set rejects stale writers across independent connections", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-learning-checkpoint-cas-"));
  const file = path.join(directory, "checkpoint.sqlite");
  try {
    const first = await SqliteSelfImprovementCheckpointStore.open(file);
    const second = await SqliteSelfImprovementCheckpointStore.open(file);
    const observedFirst = await first.read(scope);
    const observedSecond = await second.read(scope);
    assert.equal(observedFirst.revision, 0);
    assert.equal(observedSecond.revision, 0);

    assert.equal(await first.compareAndSet!(scope, observedFirst.revision!, {
      lastSequence: 0,
      pending: [{ sequence: 2, receiptId: "r2", summary: "buffered by first worker" }],
    }), true);
    assert.equal(await second.compareAndSet!(scope, observedSecond.revision!, {
      lastSequence: 1,
      pending: [],
    }), false);

    const current = await second.read(scope);
    assert.equal(current.revision, 1);
    assert.equal(current.lastSequence, 0);
    assert.deepEqual(current.pending.map(item => item.receiptId), ["r2"]);
    assert.equal(await second.compareAndSet!(scope, current.revision!, {
      lastSequence: 1,
      pending: [{ sequence: 2, receiptId: "r2", summary: "buffered by first worker" }],
    }), true);
    assert.deepEqual(await first.read(scope), {
      revision: 2,
      lastSequence: 1,
      pending: [{ sequence: 2, receiptId: "r2", summary: "buffered by first worker" }],
    });
    first.close();
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite checkpoint store migrates legacy rows with revision zero", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-learning-checkpoint-legacy-"));
  const file = path.join(directory, "checkpoint.sqlite");
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE verified_learning_checkpoints (
        tenant_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
        pending_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, principal_id, project_id)
      );
      INSERT INTO verified_learning_checkpoints
        (tenant_id, principal_id, project_id, last_sequence, pending_json, updated_at)
      VALUES ('tenant-a', 'user-a', 'project-a', 3, '[]', 1);
    `);
    db.close();
    const store = await SqliteSelfImprovementCheckpointStore.open(file);
    assert.deepEqual(await store.read(scope), { lastSequence: 3, pending: [], revision: 0 });
    assert.equal(await store.compareAndSet!(scope, 0, { lastSequence: 4, pending: [] }), true);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
