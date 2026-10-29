import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBackupBundle } from "./backup-coordinator.js";
import { sqliteFileBackupRestoreAdapter } from "./sqlite-backup-restore-adapter.js";

const createdAt = "2026-10-29T04:00:00.000Z";
const sqliteBytes = (suffix: string) => Buffer.concat([Buffer.from("SQLite format 3\0", "ascii"), Buffer.from(suffix)]);

test("SQLite restore adapter snapshots before mutation and uses close-replace-reopen lifecycle", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sofia-sqlite-restore-"));
  const database = path.join(parent, "sessions.sqlite");
  await writeFile(database, sqliteBytes("original"));
  const events: string[] = [];
  const lifecycle = {
    getOpenStore() {
      return {
        createConsistentSnapshot(destination: string) {
          events.push("snapshot");
          const bytes = sqliteBytes("original");
          // The real SqliteSessionStore uses VACUUM INTO; this fixture models its contract.
          requireFsWrite(destination, bytes);
          return destination;
        },
      };
    },
    async close() { events.push("close"); },
    async reopen() { events.push("reopen"); },
  };
  try {
    const bundle = await createBackupBundle([{
      name: "sessions",
      async snapshot() { return [{ path: "sessions/snapshot.sqlite", content: sqliteBytes("restored") }]; },
    }], createdAt);
    const adapter = sqliteFileBackupRestoreAdapter("sessions", database, "sessions/snapshot.sqlite", lifecycle);
    await adapter.preflight(bundle, ["sessions/snapshot.sqlite"]);
    const snapshot = await adapter.captureRollback();
    assert.deepEqual(events, ["snapshot"]);
    await adapter.apply(bundle, ["sessions/snapshot.sqlite"]);
    assert.deepEqual(events, ["snapshot", "close", "reopen"]);
    assert.deepEqual(await readFile(database), sqliteBytes("restored"));
    await adapter.rollback(snapshot);
    assert.deepEqual(await readFile(database), sqliteBytes("original"));
    assert.deepEqual(events, ["snapshot", "close", "reopen", "close", "reopen"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("SQLite restore adapter rejects invalid database headers before lifecycle mutation", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sofia-sqlite-restore-"));
  const database = path.join(parent, "sessions.sqlite");
  await writeFile(database, sqliteBytes("original"));
  let lifecycleCalls = 0;
  const lifecycle = {
    getOpenStore() {
      return {
        createConsistentSnapshot(destination: string) {
          lifecycleCalls += 1;
          requireFsWrite(destination, sqliteBytes("original"));
          return destination;
        },
      };
    },
    async close() { lifecycleCalls += 1; },
    async reopen() { lifecycleCalls += 1; },
  };
  try {
    const bundle = await createBackupBundle([{
      name: "sessions",
      async snapshot() { return [{ path: "sessions/snapshot.sqlite", content: Buffer.from("not a database") }]; },
    }], createdAt);
    const adapter = sqliteFileBackupRestoreAdapter("sessions", database, "sessions/snapshot.sqlite", lifecycle);
    await assert.rejects(adapter.preflight(bundle, ["sessions/snapshot.sqlite"]), /valid SQLite database header/);
    assert.equal(lifecycleCalls, 0);
    assert.deepEqual(await readFile(database), sqliteBytes("original"));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

function requireFsWrite(destination: string, bytes: Uint8Array): void {
  // Synchronous fixture helper keeps the lifecycle callback's contract synchronous.
  const fs = require("node:fs") as typeof import("node:fs");
  fs.writeFileSync(destination, bytes, { mode: 0o600 });
}
