import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileConversationStore } from "./file-store.js";
import type { ConversationSession } from "./types.js";

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";

function validSession(): ConversationSession {
  return {
    id: SESSION_ID,
    ownerId: "owner-a",
    title: "Hardening test",
    createdAt: 1,
    updatedAt: 1,
    messages: [],
  };
}

function withDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-conversation-hardening-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("removes malformed persisted JSON instead of returning unvalidated state", () => {
  withDirectory((directory) => {
    const filename = path.join(directory, SESSION_ID + ".json");
    writeFileSync(filename, "{ definitely not json", "utf8");

    const store = new FileConversationStore(directory);
    assert.equal(store.get(SESSION_ID), undefined);
    assert.equal(existsSync(filename), false);
    assert.deepEqual(store.listByOwner("owner-a"), []);
  });
});

test("removes schema-invalid persisted sessions", () => {
  withDirectory((directory) => {
    const filename = path.join(directory, SESSION_ID + ".json");
    writeFileSync(filename, JSON.stringify({ ...validSession(), ownerId: "" }), "utf8");

    const store = new FileConversationStore(directory);
    assert.equal(store.get(SESSION_ID), undefined);
    assert.equal(existsSync(filename), false);
  });
});

test("does not return or retain persisted files above the byte limit", () => {
  withDirectory((directory) => {
    const filename = path.join(directory, SESSION_ID + ".json");
    writeFileSync(filename, "x".repeat(8_000_001), "utf8");

    const store = new FileConversationStore(directory);
    assert.equal(store.get(SESSION_ID), undefined);
    assert.equal(existsSync(filename), false);
  });
});

test("rejects invalid sessions and serialized records above the byte limit on save", () => {
  withDirectory((directory) => {
    const store = new FileConversationStore(directory);
    assert.throws(() => store.save({ ...validSession(), ownerId: "" }), /Invalid conversation session/);

    const oversized: ConversationSession = {
      ...validSession(),
      messages: [{
        id: "123e4567-e89b-42d3-a456-426614174001",
        role: "user",
        content: "x".repeat(8_000_001),
        createdAt: 1,
      }],
    };
    assert.throws(() => store.save(oversized), /Invalid conversation session|exceeds storage limit/);
    assert.equal(existsSync(path.join(directory, SESSION_ID + ".json")), false);
  });
});

test("writes a valid record atomically and keeps it readable", () => {
  withDirectory((directory) => {
    const store = new FileConversationStore(directory);
    const session = validSession();
    store.save(session);

    const filename = path.join(directory, SESSION_ID + ".json");
    assert.equal(JSON.parse(readFileSync(filename, "utf8")).ownerId, "owner-a");
    assert.deepEqual(store.get(SESSION_ID), session);
  });
});
