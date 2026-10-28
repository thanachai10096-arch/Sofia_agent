import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramAdapter, type TelegramUpdate } from "./telegram.js";
import { createDiscordAdapter, type VerifiedDiscordMessage } from "./discord.js";
import { createSlackAdapter, type VerifiedSlackMessage } from "./slack.js";
import { createLineAdapter, type VerifiedLineMessage } from "./line.js";

test("Telegram adapter normalizes messages and splits oversized replies", async () => {
  let onUpdate: ((update: TelegramUpdate) => Promise<void>) | undefined;
  const sent: string[] = [];
  const adapter = createTelegramAdapter({
    async start(_signal, callback) { onUpdate = callback; },
    async sendMessage(_chatId, text) { sent.push(text); return { messageId: String(sent.length) }; },
    async stop() {},
  });
  let received: unknown;
  await adapter.start(new AbortController().signal, async (message) => { received = message; });
  assert.ok(onUpdate);
  await onUpdate!({ update_id: 1, message: { message_id: 2, date: 100, text: "hello", chat: { id: 3, type: "private" }, from: { id: 4 } } });
  assert.equal((received as { identity: { userId: string } }).identity.userId, "4");
  assert.equal((await adapter.send({ conversationId: "3", text: "x".repeat(5000) })).state, "sent");
  assert.equal(sent.length, 2);
});
test("Discord adapter ignores unverified events and bot messages", async () => {
  let onEvent: ((message: VerifiedDiscordMessage) => Promise<void>) | undefined;
  const adapter = createDiscordAdapter({
    async start(_signal, callback) { onEvent = callback; },
    async sendMessage() { return { messageId: "sent" }; },
    async stop() {},
  });
  let received = 0;
  await adapter.start(new AbortController().signal, async () => { received++; });
  assert.ok(onEvent);
  const base = { id: "m1", channelId: "c1", author: { id: "u1" }, content: "hi", createdAt: 1 };
  await onEvent!({ ...base, signatureVerified: false } as unknown as VerifiedDiscordMessage);
  await onEvent!({ ...base, signatureVerified: true, author: { id: "bot", bot: true } });
  await onEvent!({ ...base, signatureVerified: true });
  assert.equal(received, 1);
});


test("Slack adapter rejects unverified and bot events and normalizes verified human messages", async () => {
  let onEvent: ((message: VerifiedSlackMessage) => Promise<void>) | undefined;
  const adapter = createSlackAdapter({
    async start(_signal, callback) { onEvent = callback; },
    async postMessage() { return { messageId: "slack-ts-1" }; },
    async stop() {},
  });
  const received: Array<{ platform: string; userId: string; channelId: string; text: string }> = [];
  await adapter.start(new AbortController().signal, async (message) => {
    received.push({
      platform: message.platform,
      userId: message.identity.userId,
      channelId: message.identity.channelId,
      text: message.text,
    });
  });
  assert.ok(onEvent);
  const base = {
    eventId: "Ev1", messageId: "1710000000.0001", channelId: "C123", userId: "U123",
    text: "hello Sofia", createdAt: 1710000000000,
  };
  await onEvent!({ ...base, signatureVerified: false } as unknown as VerifiedSlackMessage);
  await onEvent!({ ...base, signatureVerified: true, botId: "B123" });
  await onEvent!({ ...base, signatureVerified: true });
  assert.deepEqual(received, [{
    platform: "slack", userId: "U123", channelId: "C123", text: "hello Sofia",
  }]);
});

test("Slack adapter chunks long outbound replies and fails with a safe error code", async () => {
  const chunks: string[] = [];
  const adapter = createSlackAdapter({
    async start() {},
    async postMessage(_channel, text) { chunks.push(text); return { messageId: String(chunks.length) }; },
    async stop() {},
  });
  assert.equal((await adapter.send({ conversationId: "C123", text: "x".repeat(40_000) })).state, "sent");
  assert.equal(chunks.length, 2);
  const failing = createSlackAdapter({
    async start() {},
    async postMessage() { throw new Error("secret provider detail"); },
    async stop() {},
  });
  assert.deepEqual(await failing.send({ conversationId: "C123", text: "hello" }), {
    state: "failed", errorCode: "slack_delivery_failed",
  });
});

test("LINE adapter normalizes verified events and safely splits outbound replies", async () => {
  let onEvent: ((message: VerifiedLineMessage) => Promise<void>) | undefined;
  const sent: string[] = [];
  const adapter = createLineAdapter({
    async start(_signal, callback) { onEvent = callback; },
    async pushMessage(_to, text) { sent.push(text); return { messageId: String(sent.length) }; },
    async stop() {},
  });
  let received: unknown;
  await adapter.start(new AbortController().signal, async (message) => { received = message; });
  assert.ok(onEvent);
  const base = { eventId: "ev1", messageId: "m1", userId: "U1", conversationId: "C1", text: "hello", createdAt: 1 };
  await onEvent!({ ...base, signatureVerified: false } as unknown as VerifiedLineMessage);
  await onEvent!({ ...base, signatureVerified: true });
  assert.equal((received as { platform: string }).platform, "line");
  assert.equal((await adapter.send({ conversationId: "C1", text: "x".repeat(6_000) })).state, "sent");
  assert.equal(sent.length, 2);
});
