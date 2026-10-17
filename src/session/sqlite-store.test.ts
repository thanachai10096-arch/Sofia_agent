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
