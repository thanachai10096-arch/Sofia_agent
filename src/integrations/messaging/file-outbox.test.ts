import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileMessagingOutbox, flushMessagingOutbox } from "./file-outbox.js";

test("outbound messages survive restart and are removed only after confirmed delivery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-outbox-"));
  try {
    const first = new FileMessagingOutbox(root);
    await first.enqueue("line", { conversationId: "conversation-1", text: "completed output" });
    const attempts: string[] = [];
    const failed = await flushMessagingOutbox(new FileMessagingOutbox(root), async (platform, message) => {
      attempts.push(platform + ":" + message.text);
      return false;
    });
    assert.deepEqual(failed, { sent: 0, pending: 1 });
    const retried = await flushMessagingOutbox(new FileMessagingOutbox(root), async (platform, message) => {
      attempts.push(platform + ":" + message.text);
      return true;
    });
    assert.deepEqual(retried, { sent: 1, pending: 0 });
    assert.deepEqual(attempts, ["line:completed output", "line:completed output"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("outbox rejects oversized or empty outbound content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-outbox-invalid-"));
  try {
    const outbox = new FileMessagingOutbox(root);
    await assert.rejects(outbox.enqueue("line", { conversationId: "c", text: " " }), /Invalid messaging outbox/);
    await assert.rejects(outbox.enqueue("line", { conversationId: "c", text: "x".repeat(128_001) }), /Invalid messaging outbox/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
