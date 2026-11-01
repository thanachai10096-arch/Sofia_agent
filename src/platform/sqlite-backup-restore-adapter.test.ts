import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { SqliteSessionStore } from "../session/sqlite-store.js";
import os from "node:os";
import path from "node:path";
import { createBackupBundle } from "./backup-coordinator.js";
import { sqliteFileBackupRestoreAdapter } from "./sqlite-backup-restore-adapter.js";

const createdAt = "2026-10-29T04:00:00.000Z";
const sqliteBytes = (suffix: string) => Buffer.concat([Buffer.from("SQLite format 3\0", "ascii"), Buffer.from(suffix)]);

async function validSqliteBytes(directory: string, filename: string): Promise<Uint8Array> {
  const { DatabaseSync } = await import("node:sqlite");
  const databasePath = path.join(directory, filename);
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("CREATE TABLE restore_probe (value TEXT NOT NULL); INSERT INTO restore_probe VALUES ('valid');");
  } finally {
    database.close();
  }
  const bytes = await readFile(databasePath);
  await rm(databasePath, { force: true });
  return bytes;
}

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
    const restoredBytes = await validSqliteBytes(parent, "restored-fixture.sqlite");
    const bundle = await createBackupBundle([{
      name: "sessions",
      async snapshot() { return [{ path: "sessions/snapshot.sqlite", content: restoredBytes }]; },
    }], createdAt);
    const adapter = sqliteFileBackupRestoreAdapter("sessions", database, "sessions/snapshot.sqlite", lifecycle);
    await adapter.preflight(bundle, ["sessions/snapshot.sqlite"]);
    const snapshot = await adapter.captureRollback();
    assert.deepEqual(events, ["snapshot"]);
    await adapter.apply(bundle, ["sessions/snapshot.sqlite"]);
    assert.deepEqual(events, ["snapshot", "close", "reopen"]);
    assert.deepEqual(await readFile(database), restoredBytes);
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


test("SQLite restore adapter rejects a corrupt database with a valid SQLite header", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sofia-sqlite-integrity-"));
  const database = path.join(parent, "sessions.sqlite");
  await writeFile(database, sqliteBytes("original"));
  let lifecycleCalls = 0;
  const lifecycle = {
    getOpenStore() {
      return { createConsistentSnapshot(destination: string) {
        lifecycleCalls += 1;
        requireFsWrite(destination, sqliteBytes("original"));
        return destination;
      } };
    },
    async close() { lifecycleCalls += 1; },
    async reopen() { lifecycleCalls += 1; },
  };
  try {
    const bundle = await createBackupBundle([{
      name: "sessions",
      async snapshot() {
        return [{ path: "sessions/snapshot.sqlite", content: sqliteBytes("truncated-corrupt-database") }];
      },
    }], createdAt);
    const adapter = sqliteFileBackupRestoreAdapter("sessions", database, "sessions/snapshot.sqlite", lifecycle);
    await assert.rejects(adapter.preflight(bundle, ["sessions/snapshot.sqlite"]), /integrity validation/);
    assert.equal(lifecycleCalls, 0);
    assert.deepEqual(await readFile(database), sqliteBytes("original"));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});


test("SQLite restore adapter revalidates bundle bytes immediately before live mutation", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sofia-sqlite-toctou-"));
  const database = path.join(parent, "sessions.sqlite");
  await writeFile(database, sqliteBytes("original"));
  let lifecycleCalls = 0;
  const lifecycle = {
    getOpenStore() {
      return { createConsistentSnapshot(destination: string) {
        lifecycleCalls += 1;
        requireFsWrite(destination, sqliteBytes("original"));
        return destination;
      } };
    },
    async close() { lifecycleCalls += 1; },
    async reopen() { lifecycleCalls += 1; },
  };
  try {
    const validBytes = Buffer.from(await validSqliteBytes(parent, "valid-before-mutation.sqlite"));
    const bundle = await createBackupBundle([{
      name: "sessions",
      async snapshot() { return [{ path: "sessions/snapshot.sqlite", content: validBytes }]; },
    }], createdAt);
    const adapter = sqliteFileBackupRestoreAdapter("sessions", database, "sessions/snapshot.sqlite", lifecycle);
    await adapter.preflight(bundle, ["sessions/snapshot.sqlite"]);
    // Preserve the SQLite magic header but corrupt the database page after preflight.
    const bundledBytes = bundle.files.get("sessions/snapshot.sqlite")!;
    bundledBytes[100] = 0xff;
    await assert.rejects(adapter.apply(bundle, ["sessions/snapshot.sqlite"]), /integrity validation/);
    assert.equal(lifecycleCalls, 0);
    assert.deepEqual(await readFile(database), sqliteBytes("original"));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

function requireFsWrite(destination: string, bytes: Uint8Array): void {
  // Synchronous fixture helper keeps the lifecycle callback's contract synchronous.
  writeFileSync(destination, bytes, { mode: 0o600 });
}

test("SQLite restore adapter rejects a symlinked database parent before lifecycle mutation", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sofia-sqlite-restore-"));
  const realDirectory = path.join(parent, "real");
  const aliasDirectory = path.join(parent, "alias");
  await mkdir(realDirectory);
  const database = path.join(realDirectory, "sessions.sqlite");
  await writeFile(database, sqliteBytes("original"));
  await symlink(realDirectory, aliasDirectory);
  let lifecycleCalls = 0;
  const lifecycle = {
    getOpenStore() {
      return { createConsistentSnapshot(destination: string) { lifecycleCalls += 1; requireFsWrite(destination, sqliteBytes("original")); return destination; } };
    },
    async close() { lifecycleCalls += 1; },
    async reopen() { lifecycleCalls += 1; },
  };
  try {
    const bundle = await createBackupBundle([{
      name: "sessions",
      async snapshot() { return [{ path: "sessions/snapshot.sqlite", content: sqliteBytes("restored") }]; },
    }], createdAt);
    const adapter = sqliteFileBackupRestoreAdapter("sessions", path.join(aliasDirectory, "sessions.sqlite"), "sessions/snapshot.sqlite", lifecycle);
    await assert.rejects(adapter.preflight(bundle, ["sessions/snapshot.sqlite"]), /real directory/);
    assert.equal(lifecycleCalls, 0);
    assert.deepEqual(await readFile(database), sqliteBytes("original"));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("SQLite restore adapter restores a real database and rollback reopens the previous state", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sofia-sqlite-live-restore-"));
  const livePath = path.join(parent, "live.sqlite");
  const backupPath = path.join(parent, "backup.sqlite");
  let live = await SqliteSessionStore.open(livePath);
  let backup: SqliteSessionStore | undefined;
  try {
    live.save({ id: "session-1", messages: ["before"], updatedAt: 0 });
    backup = await SqliteSessionStore.open(backupPath);
    backup.save({ id: "session-1", messages: ["restored"], updatedAt: 0 });
    // Keep the backup connection open so this committed transaction is still in WAL.
    await readFile(backupPath + "-wal");
    const bundle = await createBackupBundle([{
      name: "sessions",
      async snapshot() {
        const snapshotPath = path.join(parent, "backup-snapshot.sqlite");
        backup!.createConsistentSnapshot(snapshotPath);
        const bytes = await readFile(snapshotPath);
        await rm(snapshotPath, { force: true });
        return [{ path: "sessions/snapshot.sqlite", content: bytes }];
      },
    }], createdAt);
    const adapter = sqliteFileBackupRestoreAdapter("sessions", livePath, "sessions/snapshot.sqlite", {
      getOpenStore() { return live; },
      async close() {
        live.close();
        // Simulate stale sidecars left behind by an interrupted prior process.
        writeFileSync(livePath + "-wal", "stale-wal");
        writeFileSync(livePath + "-shm", "stale-shm");
      },
      async reopen() {
        await assert.rejects(readFile(livePath + "-wal"), { code: "ENOENT" });
        await assert.rejects(readFile(livePath + "-shm"), { code: "ENOENT" });
        live = await SqliteSessionStore.open(livePath);
      },
    });
    await adapter.preflight(bundle, ["sessions/snapshot.sqlite"]);
    const rollback = await adapter.captureRollback();
    await adapter.apply(bundle, ["sessions/snapshot.sqlite"]);
    assert.deepEqual(live.get("session-1")?.messages, ["restored"]);
    await adapter.rollback(rollback);
    assert.deepEqual(live.get("session-1")?.messages, ["before"]);
  } finally {
    try { live.close(); } catch { /* already closed during cleanup */ }
    if (backup) backup.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("SQLite restore adapter can roll back when reopening the restored database fails once", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sofia-sqlite-reopen-failure-"));
  const livePath = path.join(parent, "live.sqlite");
  const backupPath = path.join(parent, "backup.sqlite");
  let live = await SqliteSessionStore.open(livePath);
  let backup: SqliteSessionStore | undefined;
  let failNextReopen = true;
  try {
    live.save({ id: "session-1", messages: ["before"], updatedAt: 0 });
    backup = await SqliteSessionStore.open(backupPath);
    backup.save({ id: "session-1", messages: ["restored"], updatedAt: 0 });
    const bundle = await createBackupBundle([{
      name: "sessions",
      async snapshot() {
        const snapshotPath = path.join(parent, "backup-snapshot.sqlite");
        backup!.createConsistentSnapshot(snapshotPath);
        const bytes = await readFile(snapshotPath);
        await rm(snapshotPath, { force: true });
        return [{ path: "sessions/snapshot.sqlite", content: bytes }];
      },
    }], createdAt);
    const adapter = sqliteFileBackupRestoreAdapter("sessions", livePath, "sessions/snapshot.sqlite", {
      getOpenStore() { return live; },
      async close() { live.close(); },
      async reopen() {
        if (failNextReopen) {
          failNextReopen = false;
          throw new Error("simulated reopen failure");
        }
        live = await SqliteSessionStore.open(livePath);
      },
    });
    await adapter.preflight(bundle, ["sessions/snapshot.sqlite"]);
    const rollback = await adapter.captureRollback();
    await assert.rejects(adapter.apply(bundle, ["sessions/snapshot.sqlite"]), /simulated reopen failure/);
    await adapter.rollback(rollback);
    assert.deepEqual(live.get("session-1")?.messages, ["before"]);
  } finally {
    try { live.close(); } catch { /* store may be closed after injected failure */ }
    if (backup) backup.close();
    await rm(parent, { recursive: true, force: true });
  }
});
