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
  }, { botUsername: "SofiaTestBot" });
  let received: unknown;
  await adapter.start(new AbortController().signal, async (message) => { received = message; });
  assert.ok(onUpdate);
  await onUpdate!({ update_id: 1, message: { message_id: 2, date: 100, text: "hello", chat: { id: 3, type: "private" }, from: { id: 4 } } });
  assert.equal((received as { identity: { userId: string } }).identity.userId, "4");
  assert.equal((received as { directMessage?: boolean }).directMessage, true);
  await onUpdate!({ update_id: 2, message: { message_id: 3, date: 101, text: "@SofiaTestBot help", entities: [{ type: "mention", offset: 0, length: 13 }], chat: { id: -99, type: "group" }, from: { id: 4 } } });
  assert.equal((received as { addressedToBot?: boolean }).addressedToBot, true);
  await onUpdate!({ update_id: 3, message: { message_id: 4, date: 102, text: "ordinary group chat", chat: { id: -99, type: "group" }, from: { id: 4 } } });
  assert.equal((received as { addressedToBot?: boolean }).addressedToBot, undefined);
  assert.equal((await adapter.send({ conversationId: "3", text: "x".repeat(5000) })).state, "sent");
  assert.equal(sent.length, 2);
});
test("Telegram group natural chat only trusts exact bot mentions and replies", async () => {
  let onUpdate: ((update: TelegramUpdate) => Promise<void>) | undefined;
  const received: Array<{ text: string; addressedToBot?: boolean }> = [];
  const adapter = createTelegramAdapter({
    async start(_signal, callback) { onUpdate = callback; },
    async sendMessage() { return { messageId: "sent" }; },
    async stop() {},
  }, { botUsername: "@SofiaTestBot" });
  await adapter.start(new AbortController().signal, async (message) => {
    received.push({ text: message.text, addressedToBot: message.addressedToBot });
  });
  assert.ok(onUpdate);

  await onUpdate!({
    update_id: 10,
    message: {
      message_id: 10, date: 100, text: "hello @OtherBot",
      entities: [{ type: "mention", offset: 6, length: 10 }],
      chat: { id: -99, type: "group" }, from: { id: 4 },
    },
  });
  await onUpdate!({
    update_id: 11,
    message: {
      message_id: 11, date: 101, text: "thanks",
      chat: { id: -99, type: "group" }, from: { id: 4 },
      reply_to_message: { from: { username: "SofiaTestBot", is_bot: false } },
    },
  });
  await onUpdate!({
    update_id: 12,
    message: {
      message_id: 12, date: 102, text: "continue",
      chat: { id: -99, type: "group" }, from: { id: 4 },
      reply_to_message: { from: { username: "OtherBot", is_bot: true } },
    },
  });
  await onUpdate!({
    update_id: 13,
    message: {
      message_id: 13, date: 103, text: "continue",
      chat: { id: -99, type: "group" }, from: { id: 4 },
      reply_to_message: { from: { username: "SofiaTestBot", is_bot: true } },
    },
  });

  assert.deepEqual(received, [
    { text: "hello @OtherBot", addressedToBot: undefined },
    { text: "thanks", addressedToBot: undefined },
    { text: "continue", addressedToBot: undefined },
    { text: "continue", addressedToBot: true },
  ]);
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
  const base = { id: "m1", channelId: "c1", author: { id: "u1" }, content: "hi", createdAt: 1, directMessage: true, addressedToBot: true };
  await onEvent!({ ...base, signatureVerified: false } as unknown as VerifiedDiscordMessage);
  await onEvent!({ ...base, signatureVerified: true, author: { id: "bot", bot: true } });
  await onEvent!({ ...base, signatureVerified: true });
  assert.equal(received, 1);
});
