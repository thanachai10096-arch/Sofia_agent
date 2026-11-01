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


test("platform-scoped flush leaves other platforms pending", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-outbox-platform-"));
  try {
    const outbox = new FileMessagingOutbox(root);
    await outbox.enqueue("line", { conversationId: "line-chat", text: "line result" });
    await outbox.enqueue("whatsapp", { conversationId: "wa-chat", text: "whatsapp result" });
    const delivered: string[] = [];
    const result = await flushMessagingOutbox(outbox, async (platform, message) => {
      delivered.push(platform + ":" + message.text);
      return true;
    }, undefined, "line");
    assert.deepEqual(result, { sent: 1, pending: 1 });
    assert.deepEqual(delivered, ["line:line result"]);
    assert.deepEqual((await outbox.pending()).map((record) => record.platform), ["whatsapp"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("overlapping flushes for one spool do not send the same record twice in-process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-outbox-concurrent-"));
  try {
    const outbox = new FileMessagingOutbox(root);
    await outbox.enqueue("line", { conversationId: "line-chat", text: "one result" });
    let releaseSend!: (value: boolean) => void;
    let started!: () => void;
    const sendStarted = new Promise<void>((resolve) => { started = resolve; });
    const sendGate = new Promise<boolean>((resolve) => { releaseSend = resolve; });
    let sends = 0;
    const first = flushMessagingOutbox(outbox, async () => {
      sends++;
      started();
      return sendGate;
    });
    await sendStarted;
    const second = await flushMessagingOutbox(outbox, async () => {
      sends++;
      return true;
    });
    assert.deepEqual(second, { sent: 0, pending: 1 });
    releaseSend(true);
    assert.deepEqual(await first, { sent: 1, pending: 0 });
    assert.equal(sends, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("outbox lease is exclusive across independent instances and stale owners cannot acknowledge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-outbox-lease-"));
  try {
    const first = new FileMessagingOutbox(root);
    const second = new FileMessagingOutbox(root);
    const id = await first.enqueue("line", { conversationId: "line-chat", text: "leased result" });
    const oldLease = await first.claim(id, 5_000, 1_000);
    assert.ok(oldLease);
    assert.equal(await second.claim(id, 5_000, 1_000), undefined);
    const newLease = await second.claim(id, 5_000, 7_000);
    assert.ok(newLease);
    assert.notEqual(newLease, oldLease);
    assert.equal(await first.markSent(id, oldLease!), false);
    assert.equal((await second.pending()).length, 1);
    assert.equal(await second.markSent(id, newLease!), true);
    assert.equal((await first.pending()).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("outbox flush releases lease when provider send fails so another worker can retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-outbox-lease-retry-"));
  try {
    const first = new FileMessagingOutbox(root);
    const second = new FileMessagingOutbox(root);
    await first.enqueue("whatsapp", { conversationId: "wa-chat", text: "retry me" });
    const failed = await flushMessagingOutbox(first, async () => false);
    assert.deepEqual(failed, { sent: 0, pending: 1 });
    const succeeded = await flushMessagingOutbox(second, async () => true);
    assert.deepEqual(succeeded, { sent: 1, pending: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
