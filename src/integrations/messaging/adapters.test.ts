import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramAdapter, type TelegramUpdate } from "./telegram.js";
import { createDiscordAdapter, type VerifiedDiscordMessage } from "./discord.js";

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


test("Telegram voice updates use the existing poller and preserve validated sender metadata", async () => {
  let onUpdate: ((update: TelegramUpdate) => Promise<void>) | undefined;
  const voiceMessages: Array<{ userId: string; conversationId: string; fileId: string; durationMs: number }> = [];
  const adapter = createTelegramAdapter({
    async start(_signal, callback) { onUpdate = callback; },
    async sendMessage() { return { messageId: "sent" }; },
    async stop() {},
  }, {
    onVoiceMessage: async (message) => {
      voiceMessages.push({
        userId: message.userId,
        conversationId: message.conversationId,
        fileId: message.fileId,
        durationMs: message.durationMs,
      });
    },
  });
  await adapter.start(new AbortController().signal, async () => {
    throw new Error("voice updates must not be routed as text");
  });
  assert.ok(onUpdate);
  await onUpdate!({
    update_id: 10,
    message: {
      message_id: 11,
      date: 100,
      chat: { id: -100123, type: "private" },
      from: { id: 456 },
      voice: { file_id: "telegram-file-id", mime_type: "audio/ogg", file_size: 2048, duration: 7 },
    },
  });
  assert.deepEqual(voiceMessages, [{
    userId: "456",
    conversationId: "-100123",
    fileId: "telegram-file-id",
    durationMs: 7000,
  }]);
});

test("Telegram voice adapter ignores invalid duration and never invokes an absent callback", async () => {
  let onUpdate: ((update: TelegramUpdate) => Promise<void>) | undefined;
  const adapter = createTelegramAdapter({
    async start(_signal, callback) { onUpdate = callback; },
    async sendMessage() { return { messageId: "sent" }; },
    async stop() {},
  });
  await adapter.start(new AbortController().signal, async () => {});
  assert.ok(onUpdate);
  await onUpdate!({
    update_id: 1,
    message: {
      message_id: 2,
      date: 100,
      chat: { id: 3, type: "private" },
      from: { id: 4 },
      voice: { file_id: "file", duration: 0 },
    },
  });
  await onUpdate!({
    update_id: 2,
    message: {
      message_id: 3,
      date: 100,
      chat: { id: 3, type: "private" },
      from: { id: 4 },
      voice: { file_id: "file", duration: 5 },
    },
  });
});

test("Telegram voice callback receives the existing poller's AbortSignal", async () => {
  let onUpdate: ((update: TelegramUpdate) => Promise<void>) | undefined;
  let callbackSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const adapter = createTelegramAdapter({
    async start(_signal, callback) { onUpdate = callback; },
    async sendMessage() { return { messageId: "sent" }; },
    async stop() {},
  }, {
    async onVoiceMessage(_message, signal) { callbackSignal = signal; },
  });
  await adapter.start(controller.signal, async () => {});
  assert.ok(onUpdate);
  await onUpdate!({
    update_id: 20,
    message: {
      message_id: 21, date: 100, chat: { id: 3, type: "private" }, from: { id: 4 },
      voice: { file_id: "file", duration: 2 },
    },
  });
  assert.equal(callbackSignal, controller.signal);
  controller.abort();
  assert.equal(callbackSignal?.aborted, true);
});
