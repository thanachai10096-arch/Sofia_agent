import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileMessagingOutbox, flushMessagingOutbox, startMessagingOutboxRetryWorker } from "./file-outbox.js";

test("outbound messages survive restart and are removed only after confirmed delivery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-outbox-"));
  try {
    const first = new FileMessagingOutbox(root);
    await first.enqueue("line", { conversationId: "conversation-1", text: "completed output" });
    const attempts: string[] = [];
    const failed = await flushMessagingOutbox(new FileMessagingOutbox(root), async (platform, message) => {
      attempts.push(platform + ":" + message.text);
      return false;
    }, undefined, undefined, () => 1_000);
    assert.deepEqual(failed, { sent: 0, pending: 1 });
    const retried = await flushMessagingOutbox(new FileMessagingOutbox(root), async (platform, message) => {
      attempts.push(platform + ":" + message.text);
      return true;
    }, undefined, undefined, () => 31_000);
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
    const failed = await flushMessagingOutbox(first, async () => false, undefined, undefined, () => 1_000);
    assert.deepEqual(failed, { sent: 0, pending: 1 });
    const succeeded = await flushMessagingOutbox(second, async () => true, undefined, undefined, () => 31_000);
    assert.deepEqual(succeeded, { sent: 1, pending: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("repeated outbound failures become retained dead letters and can be manually requeued", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-outbox-dead-letter-"));
  try {
    const outbox = new FileMessagingOutbox(root);
    const id = await outbox.enqueue("line", { conversationId: "line-chat", text: "keep for review" });
    let now = 1_000;
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await flushMessagingOutbox(outbox, async () => false, undefined, undefined, () => now);
      assert.equal(result.pending, 1);
      now += 60 * 60_000;
    }
    const dead = (await outbox.pending()).find((record) => record.id === id);
    assert.equal(dead?.state, "dead_letter");
    assert.equal(dead?.attemptCount, 8);
    assert.equal(dead?.lastErrorCode, "provider_unavailable");
    assert.equal(await outbox.requeue(id), true);
    const requeued = (await outbox.pending()).find((record) => record.id === id);
    assert.equal(requeued?.state, "pending");
    assert.equal(requeued?.attemptCount, 0);
    assert.equal(requeued?.nextAttemptAt, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("outbox does not send a record before its persisted retry time", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-outbox-backoff-"));
  try {
    const outbox = new FileMessagingOutbox(root);
    await outbox.enqueue("line", { conversationId: "line-chat", text: "wait before retry" });
    await flushMessagingOutbox(outbox, async () => false, undefined, undefined, () => 5_000);
    let sends = 0;
    const early = await flushMessagingOutbox(outbox, async () => { sends++; return true; }, undefined, undefined, () => 34_999);
    assert.equal(sends, 0);
    assert.equal(early.pending, 1);
    const due = await flushMessagingOutbox(outbox, async () => { sends++; return true; }, undefined, undefined, () => 35_000);
    assert.equal(sends, 1);
    assert.equal(due.pending, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("outbox persists bounded metadata-only attempt history across restart and requeue", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-outbox-history-"));
  try {
    const outbox = new FileMessagingOutbox(root);
    const id = await outbox.enqueue("line", { conversationId: "line-chat", text: "private result text" });
    let now = 10_000;
    for (let attempt = 0; attempt < 10; attempt++) {
      await flushMessagingOutbox(outbox, async () => false, undefined, undefined, () => now);
      now += 60 * 60_000;
    }
    const restarted = new FileMessagingOutbox(root);
    const record = (await restarted.pending()).find((item) => item.id === id);
    assert.equal(record?.attemptCount, 8);
    assert.equal(record?.attemptHistory?.length, 8);
    assert.ok(record?.attemptHistory?.every((entry) =>
      entry.outcome === "failed" && entry.code === "provider_unavailable" && Number.isFinite(entry.at)));
    assert.equal(JSON.stringify(record?.attemptHistory).includes("private result text"), false);
    assert.equal(await restarted.requeue(id), true);
    const requeued = (await restarted.pending()).find((item) => item.id === id);
    assert.equal(requeued?.attemptCount, 0);
    assert.equal(requeued?.attemptHistory?.length, 8, "manual requeue preserves prior audit history");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("retry worker rejects unsafe polling intervals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-outbox-worker-"));
  try {
    const outbox = new FileMessagingOutbox(root);
    const { startMessagingOutboxRetryWorker } = await import("./file-outbox.js");
    assert.throws(() => startMessagingOutboxRetryWorker(outbox, {
      platform: "line",
      intervalMs: 999,
      send: async () => true,
    }), /Invalid messaging outbox retry worker interval/);
    assert.throws(() => startMessagingOutboxRetryWorker(outbox, {
      platform: "line",
      intervalMs: 60 * 60_000 + 1,
      send: async () => true,
    }), /Invalid messaging outbox retry worker interval/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("provider and observability failures record only one delivery attempt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-outbox-single-attempt-"));
  try {
    const outbox = new FileMessagingOutbox(root);
    const id = await outbox.enqueue("line", { conversationId: "line-chat", text: "single attempt" });
    const result = await flushMessagingOutbox(
      outbox,
      async () => { throw new Error("provider timeout"); },
      () => { throw new Error("metrics backend unavailable"); },
      undefined,
      () => 10_000,
    );
    assert.deepEqual(result, { sent: 0, pending: 1 });
    const record = (await outbox.pending()).find((item) => item.id === id);
    assert.equal(record?.attemptCount, 1);
    assert.equal(record?.attemptHistory?.length, 1);
    assert.equal(record?.lastErrorCode, "provider_unavailable");
    assert.equal(await outbox.claim(id, 5_000, 10_001) !== undefined, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("retry worker stop waits for an in-flight delivery before shutdown completes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-outbox-worker-stop-"));
  try {
    const outbox = new FileMessagingOutbox(root);
    const id = await outbox.enqueue("line", { conversationId: "line-chat", text: "finish before stop" });
    let releaseSend!: (value: boolean) => void;
    let started!: () => void;
    const sendStarted = new Promise<void>((resolve) => { started = resolve; });
    const sendGate = new Promise<boolean>((resolve) => { releaseSend = resolve; });
    let sends = 0;
    const worker = startMessagingOutboxRetryWorker(outbox, {
      platform: "line",
      intervalMs: 1_000,
      send: async () => {
        sends++;
        started();
        return sendGate;
      },
    });

    await sendStarted;
    let stopCompleted = false;
    const stopping = worker.stop().then(() => { stopCompleted = true; });
    await Promise.resolve();
    assert.equal(stopCompleted, false, "stop must wait while provider delivery is unresolved");

    releaseSend(true);
    await stopping;
    assert.equal(stopCompleted, true);
    assert.equal(sends, 1);
    assert.equal((await outbox.pending()).some((record) => record.id === id), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("manual requeue cannot rewrite retry metadata while another worker holds the lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-outbox-requeue-lease-"));
  try {
    const deliveryWorker = new FileMessagingOutbox(root);
    const operatorWorker = new FileMessagingOutbox(root);
    const id = await deliveryWorker.enqueue("line", { conversationId: "line-chat", text: "leased for delivery" });
    const lease = await deliveryWorker.claim(id);
    assert.ok(lease);

    assert.equal(await operatorWorker.requeue(id), false);
    const unchanged = (await operatorWorker.pending()).find((record) => record.id === id);
    assert.equal(unchanged?.attemptCount, undefined);
    assert.equal(unchanged?.state, undefined);

    await deliveryWorker.releaseClaim(id, lease!);
    assert.equal(await operatorWorker.requeue(id), true);
    const requeued = (await operatorWorker.pending()).find((record) => record.id === id);
    assert.equal(requeued?.state, "pending");
    assert.equal(requeued?.attemptCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("retry worker contains a throwing failure callback when a flush itself fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-outbox-worker-callback-"));
  try {
    const outbox = new FileMessagingOutbox(root);
    outbox.pending = async () => { throw new Error("spool unavailable"); };
    let notifications = 0;
    const worker = startMessagingOutboxRetryWorker(outbox, {
      platform: "line",
      intervalMs: 1_000,
      send: async () => true,
      onFailure: () => {
        notifications++;
        throw new Error("metrics backend unavailable");
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await worker.stop();
    assert.equal(notifications, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("outbox lease rejects invalid timestamps before creating a lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-outbox-lease-time-"));
  try {
    const outbox = new FileMessagingOutbox(root);
    const id = await outbox.enqueue("line", { conversationId: "line-chat", text: "timestamp validation" });
    await assert.rejects(outbox.claim(id, 5_000, Number.NaN), /Invalid messaging outbox lease/);
    await assert.rejects(outbox.claim(id, 5_000, -1), /Invalid messaging outbox lease/);
    await assert.rejects(outbox.claim(id, 5_000, Number.MAX_SAFE_INTEGER), /Invalid messaging outbox lease/);
    assert.ok(await outbox.claim(id, 5_000, 1_000), "invalid timestamps must not leave a lock behind");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
