import assert from "node:assert/strict";
import test from "node:test";
import { splitMessage } from "./format.js";
import { createTelegramAdapter, type TelegramUpdate } from "./telegram.js";
import { createDiscordAdapter, type VerifiedDiscordMessage } from "./discord.js";
import { createSlackAdapter, type VerifiedSlackMessage } from "./slack.js";
import { createLineAdapter, type VerifiedLineMessage } from "./line.js";
import { createWhatsAppAdapter, type VerifiedWhatsAppMessage } from "./whatsapp.js";
import { createMatrixAdapter, type VerifiedMatrixMessage } from "./matrix.js";

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
test("Telegram chunking preserves emoji across message boundaries", async () => {
  const chunks: string[] = [];
  const adapter = createTelegramAdapter({
    async start() {},
    async sendMessage(_chatId, text) { chunks.push(text); return { messageId: String(chunks.length) }; },
    async stop() {},
  });
  const output = "x".repeat(4_095) + "🙂" + "y".repeat(4_200);
  assert.equal((await adapter.send({ conversationId: "chat-1", text: output })).state, "sent");
  assert.ok(chunks.every((chunk) => chunk.length <= 4_096));
  assert.equal(chunks.join(""), output);
  assert.ok(chunks.every((chunk) => {
    const last = chunk.charCodeAt(chunk.length - 1);
    return !(last >= 0xd800 && last <= 0xdbff);
  }));
  assert.ok(chunks.every((chunk) => {
    const first = chunk.charCodeAt(0);
    return !(first >= 0xdc00 && first <= 0xdfff);
  }));
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

test("WhatsApp adapter normalizes verified messages and safely chunks replies", async () => {
  let onEvent: ((message: VerifiedWhatsAppMessage) => Promise<void>) | undefined;
  const sent: string[] = [];
  const adapter = createWhatsAppAdapter({
    async start(_signal, callback) { onEvent = callback; },
    async sendMessage(_to, text) { sent.push(text); return { messageId: String(sent.length) }; },
    async stop() {},
  });
  let received: unknown;
  await adapter.start(new AbortController().signal, async (message) => { received = message; });
  assert.ok(onEvent);
  const base = { messageId: "wamid.1", phoneNumberId: "123456789012345", senderPhoneId: "66812345678", text: "hello", createdAt: 1 };
  await onEvent!({ ...base, signatureVerified: false } as unknown as VerifiedWhatsAppMessage);
  await onEvent!({ ...base, signatureVerified: true });
  assert.equal((received as { platform: string }).platform, "whatsapp");
  assert.equal((await adapter.send({ conversationId: "66812345678", text: "x".repeat(5_000) })).state, "sent");
  assert.equal(sent.length, 2);
});


test("Matrix adapter accepts only authenticated events and normalizes room identity", async () => {
  let onEvent: ((message: VerifiedMatrixMessage) => Promise<void>) | undefined;
  const adapter = createMatrixAdapter({
    async start(_signal, callback) { onEvent = callback; },
    async sendMessage() { return { messageId: "matrix-event-1" }; },
    async stop() {},
  });
  const received: Array<{ platform: string; userId: string; channelId: string; conversationId: string; text: string }> = [];
  await adapter.start(new AbortController().signal, async (message) => {
    received.push({
      platform: message.platform,
      userId: message.identity.userId,
      channelId: message.identity.channelId,
      conversationId: message.identity.conversationId,
      text: message.text,
    });
  });
  assert.ok(onEvent);
  const base = { eventId: "$event-1", roomId: "!room:example.org", senderId: "@alice:example.org", text: "hello Sofia", createdAt: 1710000000000 };
  await onEvent!({ ...base, authenticated: false } as unknown as VerifiedMatrixMessage);
  await onEvent!({ ...base, authenticated: true, text: 42 } as unknown as VerifiedMatrixMessage);
  await onEvent!({ ...base, authenticated: true });
  assert.deepEqual(received, [{
    platform: "matrix",
    userId: "@alice:example.org",
    channelId: "!room:example.org",
    conversationId: "!room:example.org",
    text: "hello Sofia",
  }]);
});

test("Matrix adapter chunks long outbound messages and returns safe delivery failures", async () => {
  const chunks: string[] = [];
  const adapter = createMatrixAdapter({
    async start() {},
    async sendMessage(_roomId, text) { chunks.push(text); return { messageId: "$event-" + chunks.length }; },
    async stop() {},
  });
  const output = "x".repeat(65_000);
  const receipt = await adapter.send({ conversationId: "!room:example.org", text: output });
  assert.equal(receipt.state, "sent");
  assert.equal(chunks.length, 3);
  assert.equal(chunks.join(""), output);
  assert.ok(chunks.every((chunk) => chunk.length <= 30_000));

  const failing = createMatrixAdapter({
    async start() {},
    async sendMessage() { throw new Error("secret homeserver detail"); },
    async stop() {},
  });
  assert.deepEqual(await failing.send({ conversationId: "!room:example.org", text: "hello" }), {
    state: "failed",
    errorCode: "matrix_delivery_failed",
  });
});

test("shared message splitter preserves content and validates platform limits", () => {
  assert.deepEqual(splitMessage("", 32), [""]);
  assert.deepEqual(splitMessage("x".repeat(32), 32), ["x".repeat(32)]);
  assert.throws(() => splitMessage("hello", 31), /between 32 and 100000/);
  assert.throws(() => splitMessage("hello", Number.NaN), /between 32 and 100000/);

  const source = "a".repeat(31) + "🙂" + "b".repeat(40) + "🚀".repeat(20);
  const chunks = splitMessage(source, 32);
  assert.ok(chunks.every((chunk) => chunk.length <= 32));
  assert.equal(chunks.join(""), source);
  assert.ok(chunks.every((chunk) => {
    const last = chunk.charCodeAt(chunk.length - 1);
    return !(last >= 0xd800 && last <= 0xdbff);
  }));
  assert.ok(chunks.every((chunk) => {
    const first = chunk.charCodeAt(0);
    return !(first >= 0xdc00 && first <= 0xdfff);
  }));
});
