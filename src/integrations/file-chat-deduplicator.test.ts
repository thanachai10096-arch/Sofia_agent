import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileChatMessageDeduplicator } from "./file-chat-deduplicator.js";

test("atomically allows only one concurrent claim for the same key", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sofia-chat-dedupe-"));
  try {
    const first = new FileChatMessageDeduplicator(directory);
    const second = new FileChatMessageDeduplicator(directory);
    const results = await Promise.all([
      first.claim("telegram|chat-1|message-1"),
      second.claim("telegram|chat-1|message-1"),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await first.claim("telegram|chat-1|message-1"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists successful claims across deduplicator instances and releases failed claims", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sofia-chat-dedupe-"));
  try {
    const beforeRestart = new FileChatMessageDeduplicator(directory);
    assert.equal(await beforeRestart.claim("discord|channel-7|event-9"), true);

    const afterRestart = new FileChatMessageDeduplicator(directory);
    assert.equal(await afterRestart.claim("discord|channel-7|event-9"), false);
    await afterRestart.release("discord|channel-7|event-9");
    assert.equal(await afterRestart.claim("discord|channel-7|event-9"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not expose raw provider IDs in marker filenames and rejects empty keys", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sofia-chat-dedupe-"));
  try {
    const dedupe = new FileChatMessageDeduplicator(directory);
    assert.equal(await dedupe.claim("private-conversation-id"), true);
    await assert.rejects(dedupe.claim(""), /non-empty/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
