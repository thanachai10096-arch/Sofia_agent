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
  assert.equal((received as { directMessage?: boolean }).directMessage, true);
  await onUpdate!({ update_id: 2, message: { message_id: 3, date: 101, text: "group chatter", chat: { id: -30, type: "group" }, from: { id: 5 } } });
  assert.equal((received as { directMessage?: boolean }).directMessage, undefined,
    "group messages must not be marked as trusted direct messages");
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
  const base = { id: "m1", channelId: "c1", author: { id: "u1" }, content: "hi", createdAt: 1, directMessage: true, addressedToBot: true };
  await onEvent!({ ...base, signatureVerified: false } as unknown as VerifiedDiscordMessage);
  await onEvent!({ ...base, signatureVerified: true, author: { id: "bot", bot: true } });
  await onEvent!({ ...base, signatureVerified: true });
  assert.equal(received, 1);
});
