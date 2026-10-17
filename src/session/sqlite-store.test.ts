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

test("new SQLite session storage uses private directory and database permissions", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-session-permissions-"));
  const privateDir = path.join(dir, "private");
  const file = path.join(privateDir, "sessions.sqlite");
  try {
    const store = await SqliteSessionStore.open(file);
    store.close();
    assert.equal(fs.statSync(privateDir).mode & 0o077, 0);
    assert.equal(fs.statSync(file).mode & 0o077, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite session storage refuses an existing directory accessible by group or others", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-session-insecure-dir-"));
  const file = path.join(dir, "sessions.sqlite");
  try {
    fs.chmodSync(dir, 0o755);
    await assert.rejects(
      SqliteSessionStore.open(file),
      /Session storage directory must not be accessible by group or others/,
    );
  } finally {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite session storage refuses an existing database file accessible by group or others", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-session-insecure-file-"));
  const file = path.join(dir, "sessions.sqlite");
  try {
    fs.writeFileSync(file, "not modified by the store", { mode: 0o644 });
    await assert.rejects(
      SqliteSessionStore.open(file),
      /Session database file must not be accessible by group or others/,
    );
    assert.equal(fs.readFileSync(file, "utf8"), "not modified by the store");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

