import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConversationService } from "./session.js";
import { FileConversationStore } from "./file-store.js";

test("persists sessions across store instances and filters owners", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-conversations-"));
  try {
    const service = new ConversationService(new FileConversationStore(directory));
    const session = service.create("alice");
    service.append("alice", session.id, { role: "user", content: "Continue this later" });

    const restarted = new ConversationService(new FileConversationStore(directory));
    assert.equal(restarted.get("alice", session.id)?.messages[0]?.content, "Continue this later");
    assert.equal(restarted.list("bob").length, 0);
    assert.equal(restarted.list("alice").length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("durable store supports clearing and deleting a session", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-conversations-"));
  try {
    const store = new FileConversationStore(directory);
    const service = new ConversationService(store);
    const session = service.create("alice");
    service.append("alice", session.id, { role: "user", content: "Erase this" });
    assert.equal(service.clear("alice", session.id).messages.length, 0);
    assert.equal(service.delete("alice", session.id), true);
    assert.equal(service.get("alice", session.id), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects unsafe IDs and malformed persisted records", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-conversations-"));
  try {
    const store = new FileConversationStore(directory);
    assert.throws(() => store.get("../secret"), /Unsafe conversation id/i);
    assert.throws(() => store.delete("../../secret"), /Unsafe conversation id/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
