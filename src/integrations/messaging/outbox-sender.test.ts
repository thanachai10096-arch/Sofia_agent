import assert from "node:assert/strict";
import test from "node:test";
import { createMessagingOutboxSender } from "./outbox-sender.js";
import type { MessagingAdapter, OutboundMessage } from "./types.js";

function adapter(platform: "telegram" | "discord", send: (message: OutboundMessage) => Promise<{ state: "sent" | "failed" | "unknown" }>): MessagingAdapter {
  return {
    platform,
    async start() {},
    async send(message) { return send(message); },
    async stop() {},
  };
}

const delivery = {
  messageId: "outbox-message-id",
  jobId: "job-id",
  eventType: "job.completed",
  destination: "telegram:123456",
  payload: { text: "Task completed" },
};

test("outbox sender routes a validated notification through the selected adapter", async () => {
  let sent: OutboundMessage | undefined;
  const sender = createMessagingOutboxSender([
    adapter("telegram", async (message) => { sent = message; return { state: "sent" }; }),
  ]);
  await sender(delivery);
  assert.deepEqual(sent, { conversationId: "123456", text: "Task completed", deliveryId: "outbox-message-id" });
});

test("outbox sender supports Discord destinations without accepting arbitrary schemes", async () => {
  let sent: OutboundMessage | undefined;
  const sender = createMessagingOutboxSender([
    adapter("discord", async (message) => { sent = message; return { state: "sent" }; }),
  ]);
  await sender({ ...delivery, destination: "discord:987654" });
  assert.equal(sent?.conversationId, "987654");
});

test("outbox sender rejects unsupported event types and malformed destinations", async () => {
  const sender = createMessagingOutboxSender([
    adapter("telegram", async () => ({ state: "sent" })),
  ]);
  await assert.rejects(sender({ ...delivery, eventType: "job.created" }), /Unsupported outbox notification event/);
  await assert.rejects(sender({ ...delivery, destination: "https://example.com" }), /Unsupported outbox messaging destination/);
  await assert.rejects(sender({ ...delivery, destination: "telegram:" }), /Unsupported outbox messaging destination/);
});

test("outbox sender rejects invalid or oversized payloads", async () => {
  const sender = createMessagingOutboxSender([
    adapter("telegram", async () => ({ state: "sent" })),
  ]);
  await assert.rejects(sender({ ...delivery, payload: { text: "  " } }), /invalid text/);
  await assert.rejects(sender({ ...delivery, payload: { text: "x".repeat(16_001) } }), /invalid text/);
  await assert.rejects(sender({ ...delivery, payload: "Task completed" }), /must be an object/);
});

test("outbox sender retries non-sent delivery receipts by throwing", async () => {
  const sender = createMessagingOutboxSender([
    adapter("telegram", async () => ({ state: "unknown" })),
  ]);
  await assert.rejects(sender(delivery), /delivery was unknown/);
});

test("outbox sender fails closed when the platform adapter is not enabled", async () => {
  const sender = createMessagingOutboxSender([]);
  await assert.rejects(sender(delivery), /No enabled messaging adapter/);
});

test("outbox sender rejects duplicate platform adapters at construction", () => {
  assert.throws(() => createMessagingOutboxSender([
    adapter("telegram", async () => ({ state: "sent" })),
    adapter("telegram", async () => ({ state: "sent" })),
  ]), /Duplicate messaging adapter/);
});

test("outbox sender does not send an already-aborted delivery", async () => {
  let called = false;
  const sender = createMessagingOutboxSender([
    adapter("telegram", async () => { called = true; return { state: "sent" }; }),
  ]);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(sender({ ...delivery, signal: controller.signal }), /cancelled/);
  assert.equal(called, false);
});
