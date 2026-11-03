import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteSessionStore } from "./sqlite-store.js";

test("SQLite sessions survive closing and reopening with exact transcript order", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-session-test-"));
  const file = path.join(dir, "sessions.sqlite");
  try {
    const first = await SqliteSessionStore.open(file);
    const session = first.getOrCreate("conversation-1");
    session.messages.push("user: สวัสดี", "assistant: Hello", 'tool: {"ok":true}');
    first.save(session);
    first.close();

    const second = await SqliteSessionStore.open(file);
    assert.deepEqual(second.get("conversation-1")?.messages, [
      "user: สวัสดี", "assistant: Hello", 'tool: {"ok":true}',
    ]);
    second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite transcript pagination and full-text search work", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-session-test-"));
  const store = await SqliteSessionStore.open(path.join(dir, "sessions.sqlite"));
  try {
    store.save({ id: "alpha", messages: ["planning launch", "deploy safely"], updatedAt: 0 });
    store.save({ id: "beta", messages: ["unrelated note", "planning recovery"], updatedAt: 0 });
    assert.deepEqual(store.listMessages("alpha", { limit: 1, offset: 1 }), ["deploy safely"]);
    assert.deepEqual(store.search("recovery").map((session) => session.id), ["beta"]);
    assert.deepEqual(store.search("  "), []);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid transcript writes do not replace stored messages", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-session-test-"));
  const store = await SqliteSessionStore.open(path.join(dir, "sessions.sqlite"));
  try {
    store.save({ id: "stable", messages: ["keep me"], updatedAt: 0 });
    assert.throws(() => store.save({ id: "stable", messages: [1 as unknown as string], updatedAt: 0 }));
    assert.deepEqual(store.get("stable")?.messages, ["keep me"]);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("multiple store connections can persist sessions to the same database", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-session-concurrent-"));
  const file = path.join(dir, "sessions.sqlite");
  const first = await SqliteSessionStore.open(file);
  const second = await SqliteSessionStore.open(file);
  try {
    first.save({ id: "first", messages: ["one"], updatedAt: 0 });
    second.save({ id: "second", messages: ["two"], updatedAt: 0 });
    assert.deepEqual(first.get("second")?.messages, ["two"]);
    assert.deepEqual(second.get("first")?.messages, ["one"]);
  } finally {
    first.close();
    second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("schema migration initializes version 1 and refuses unknown future schemas", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-session-migration-"));
  const file = path.join(dir, "sessions.sqlite");
  try {
    const store = await SqliteSessionStore.open(file);
    store.close();
    const db = new DatabaseSync(file);
    try {
      assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), 1);
      db.exec("PRAGMA user_version = 999");
    } finally {
      db.close();
    }
    await assert.rejects(SqliteSessionStore.open(file), /newer than this Sofia Agent supports/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("failed transcript transaction rolls back without losing the previous transcript", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-session-recovery-"));
  const file = path.join(dir, "sessions.sqlite");
  const store = await SqliteSessionStore.open(file);
  const db = new DatabaseSync(file);
  try {
    store.save({ id: "rollback", messages: ["preserve this"], updatedAt: 0 });
    db.exec(`
      CREATE TRIGGER reject_test_message
      BEFORE INSERT ON session_messages
      WHEN NEW.content = 'force-transaction-error'
      BEGIN
        SELECT RAISE(ABORT, 'forced transaction failure');
      END;
    `);
    assert.throws(
      () => store.save({ id: "rollback", messages: ["replacement", "force-transaction-error"], updatedAt: 0 }),
      /forced transaction failure/,
    );
    assert.deepEqual(store.get("rollback")?.messages, ["preserve this"]);
  } finally {
    db.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("SQLite transcripts survive closing and reopening Sofia's session store", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-session-agent-restart-"));
  const file = path.join(dir, "sessions.sqlite");
  const firstStore = await SqliteSessionStore.open(file);
  try {
    firstStore.save({
      id: "restart-session",
      messages: ["user: จำการสนทนานี้ไว้", "assistant: บันทึกแล้ว"],
      updatedAt: 0,
    });
  } finally {
    firstStore.close();
  }

  const reopenedStore = await SqliteSessionStore.open(file);
  try {
    assert.deepEqual(reopenedStore.get("restart-session")?.messages, [
      "user: จำการสนทนานี้ไว้",
      "assistant: บันทึกแล้ว",
    ]);
  } finally {
    reopenedStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite transcript files and WAL sidecars are private on POSIX without loosening existing paths", {
  skip: process.platform === "win32",
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-session-permissions-"));
  const privateDir = path.join(root, "new-private-dir");
  const file = path.join(privateDir, "sessions.sqlite");
  let store: SqliteSessionStore | undefined;
  try {
    store = await SqliteSessionStore.open(file);
    store.save({ id: "private-session", messages: ["private transcript"], updatedAt: 0 });

    assert.equal(fs.statSync(privateDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${file}${suffix}`;
      assert.equal(fs.existsSync(sidecar), true, `expected SQLite sidecar ${suffix}`);
      assert.equal(fs.statSync(sidecar).mode & 0o077, 0, `${suffix} must not allow group/other access`);
    }

    store.close();
    store = undefined;

    // Reopening an existing database tightens group/other access, but an existing
    // directory's permissions are not changed as a side effect.
    fs.chmodSync(file, 0o644);
    fs.chmodSync(privateDir, 0o750);
    store = await SqliteSessionStore.open(file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(privateDir).mode & 0o777, 0o750);
  } finally {
    store?.close();
    if (fs.existsSync(privateDir)) fs.chmodSync(privateDir, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("SQLite session storage rejects a database symlink without changing its target permissions or contents", {
  skip: process.platform === "win32",
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-session-symlink-"));
  const target = path.join(dir, "unrelated.txt");
  const link = path.join(dir, "sessions.sqlite");
  try {
    fs.writeFileSync(target, "leave this file alone", { mode: 0o644 });
    fs.symlinkSync(target, link);
    await assert.rejects(
      SqliteSessionStore.open(link),
      /regular files, not symbolic links/,
    );
    assert.equal(fs.statSync(target).mode & 0o777, 0o644);
    assert.equal(fs.readFileSync(target, "utf8"), "leave this file alone");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite session storage rejects a directory as a database path", {
  skip: process.platform === "win32",
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-session-directory-path-"));
  const existingFile = path.join(dir, "keep.txt");
  try {
    fs.writeFileSync(existingFile, "leave this file alone", { mode: 0o644 });
    await assert.rejects(
      SqliteSessionStore.open(dir),
      /regular files/,
    );
    assert.equal(fs.readFileSync(existingFile, "utf8"), "leave this file alone");
    assert.equal(fs.statSync(existingFile).mode & 0o777, 0o644);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite consistent snapshot includes committed WAL data without stopping the live store", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-session-snapshot-"));
  const source = path.join(dir, "sessions.sqlite");
  const snapshot = path.join(dir, "snapshot.sqlite");
  const store = await SqliteSessionStore.open(source);
  try {
    store.save({ id: "snapshot-live", messages: ["committed in WAL", "second row"], updatedAt: 0 });
    assert.equal(fs.existsSync(`${source}-wal`), true);
    assert.equal(store.createConsistentSnapshot(snapshot), snapshot);
    assert.equal(fs.statSync(snapshot).isFile(), true);
    if (process.platform !== "win32") assert.equal(fs.statSync(snapshot).mode & 0o777, 0o600);

    const snapshotStore = await SqliteSessionStore.open(snapshot);
    try {
      assert.deepEqual(snapshotStore.get("snapshot-live")?.messages, ["committed in WAL", "second row"]);
      store.save({ id: "live-only", messages: ["not in earlier snapshot"], updatedAt: 0 });
      assert.equal(snapshotStore.get("live-only"), undefined);
    } finally {
      snapshotStore.close();
    }
    assert.deepEqual(store.get("live-only")?.messages, ["not in earlier snapshot"]);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite snapshot refuses to overwrite existing files and rejects unsafe destinations", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-session-snapshot-safety-"));
  const source = path.join(dir, "sessions.sqlite");
  const existing = path.join(dir, "keep.txt");
  const store = await SqliteSessionStore.open(source);
  try {
    fs.writeFileSync(existing, "preserve existing destination");
    assert.throws(() => store.createConsistentSnapshot(existing));
    assert.equal(fs.readFileSync(existing, "utf8"), "preserve existing destination");
    assert.throws(() => store.createConsistentSnapshot(source), /must differ/);
    assert.throws(() => store.createConsistentSnapshot(path.join(dir, "missing", "snapshot.sqlite")));
    assert.equal(fs.existsSync(path.join(dir, "missing")), false);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("in-memory SQLite stores cannot create a file snapshot by path", async () => {
  const store = await SqliteSessionStore.open(":memory:");
  try {
    assert.throws(() => store.createConsistentSnapshot(path.join(os.tmpdir(), "unused-sofia-snapshot.sqlite")), /in-memory/);
  } finally {
    store.close();
  }
});

test("SQLite consistent snapshot safely supports apostrophes in destination paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-session-snapshot-quote-"));
  const dir = path.join(root, "user's backups");
  fs.mkdirSync(dir);
  const source = path.join(root, "sessions.sqlite");
  const snapshot = path.join(dir, "user's snapshot.sqlite");
  const store = await SqliteSessionStore.open(source);
  try {
    store.save({ id: "quoted-path", messages: ["still readable"], updatedAt: 0 });
    store.createConsistentSnapshot(snapshot);
    const copied = await SqliteSessionStore.open(snapshot);
    try {
      assert.deepEqual(copied.get("quoted-path")?.messages, ["still readable"]);
    } finally {
      copied.close();
    }
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
