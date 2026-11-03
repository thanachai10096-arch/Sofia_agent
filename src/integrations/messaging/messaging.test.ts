import assert from "node:assert/strict";
import test from "node:test";
import { createMessagingGateway } from "./gateway.js";
import { createTelegramAdapter } from "./telegram.js";
import { createTelegramHttpTransport } from "./telegram-http-transport.js";
import { splitMessage } from "./format.js";
import { messagingSessionKey } from "./session-key.js";
import { verifyDiscordRequest, verifyTelegramWebhookSecret } from "./platform-security.js";
import type { InboundMessage, MessagingAdapter } from "./types.js";

const message = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
  platform: "telegram", messageId: "m1",
  identity: { platform: "telegram", userId: "u1", channelId: "c1", conversationId: "conv1" },
  text: "hello", attachments: [], receivedAt: 1, ...overrides,
});
function adapter(sent: string[] = [], platform: "telegram" | "discord" = "telegram"): MessagingAdapter {
  return {
    platform, async start(_signal, _onMessage) {}, async stop() {},
    async send(input) { sent.push(input.text); return { state: "sent" }; },
  };
}

test("gateway is disabled by default and never invokes handler", async () => {
  let called = false;
  const gateway = createMessagingGateway({ adapters: [adapter()], onMessage: async () => { called = true; return "reply"; } });
  assert.deepEqual(await gateway.dispatch(message()), { status: "disabled" });
  await gateway.start();
  assert.equal(called, false);
});
test("gateway enforces allowlist before invoking Sofia handler", async () => {
  let called = false;
  const gateway = createMessagingGateway({ enabled: true, adapters: [adapter()], allowUser: () => false, onMessage: async () => { called = true; } });
  assert.deepEqual(await gateway.dispatch(message()), { status: "forbidden" });
  assert.equal(called, false);
});
test("policy errors fail closed", async () => {
  let called = false;
  const gateway = createMessagingGateway({
    enabled: true, adapters: [adapter()], allowUser: async () => { throw new Error("policy unavailable"); },
    onMessage: async () => { called = true; },
  });
  assert.deepEqual(await gateway.dispatch(message()), { status: "forbidden" });
  assert.equal(called, false);
});
test("gateway routes an allowed message through injected shared handler and replies", async () => {
  const sent: string[] = [];
  const gateway = createMessagingGateway({ enabled: true, adapters: [adapter(sent)], allowUser: () => true, onMessage: async (m) => m.text.toUpperCase() });
  assert.deepEqual(await gateway.dispatch(message()), { status: "handled" });
  assert.deepEqual(sent, ["HELLO"]);
  await gateway.stop();
  assert.equal(await gateway.send("telegram", { conversationId: "conv1", text: "x" }), false);
});
test("gateway reuses the injected atomic deduplicator and releases failed work", async () => {
  const claimed = new Set<string>();
  const released: string[] = [];
  const deduplicator = {
    claim(key: string) { if (claimed.has(key)) return false; claimed.add(key); return true; },
    release(key: string) { released.push(key); claimed.delete(key); },
  };
  let calls = 0;
  const gateway = createMessagingGateway({
    enabled: true, adapters: [adapter()], allowUser: () => true, deduplicator,
    onMessage: async () => { calls++; return "ok"; },
  });
  assert.equal((await gateway.dispatch(message())).status, "handled");
  assert.equal((await gateway.dispatch(message())).status, "duplicate");
  assert.equal(calls, 1);
  await gateway.stop();

  const failing = createMessagingGateway({
    enabled: true, adapters: [adapter()], allowUser: () => true, deduplicator,
    onMessage: async () => { throw new Error("temporary downstream failure"); },
  });
  await assert.rejects(() => failing.dispatch(message({ messageId: "m2" })), /temporary downstream failure/);
  assert.equal(released.length, 1);
  assert.ok(![...claimed].some((key) => key.endsWith("2:m2")));
  await failing.stop();
});
test("rate limit is scoped by platform, user and channel", async () => {
  let time = 1_000;
  const gateway = createMessagingGateway({ enabled: true, adapters: [adapter()], allowUser: () => true, maxMessagesPerWindow: 1, now: () => time, onMessage: async () => {} });
  assert.equal((await gateway.dispatch(message())).status, "handled");
  assert.equal((await gateway.dispatch(message({ messageId: "m2" }))).status, "rate_limited");
  time += 60_001;
  assert.equal((await gateway.dispatch(message({ messageId: "m3" }))).status, "handled");
  await gateway.stop();
});
test("gateway uses injected shared rate limiter and fails closed when it errors", async () => {
  const consumed: Array<{ key: string; limit: number; windowMs: number; now: number }> = [];
  const gateway = createMessagingGateway({
    enabled: true,
    adapters: [adapter()],
    allowUser: () => true,
    maxMessagesPerWindow: 2,
    rateWindowMs: 5_000,
    now: () => 1234,
    rateLimiter: {
      consume(input) { consumed.push(input); return false; },
    },
    onMessage: async () => { throw new Error("must not execute"); },
  });
  assert.equal((await gateway.dispatch(message())).status, "rate_limited");
  assert.equal(consumed.length, 1);
  assert.deepEqual(consumed[0], {
    key: "8:telegram|2:u1|2:c1",
    limit: 2,
    windowMs: 5_000,
    now: 1234,
  });
  await gateway.stop();

  const broken = createMessagingGateway({
    enabled: true,
    adapters: [adapter()],
    allowUser: () => true,
    rateLimiter: { consume() { throw new Error("store unavailable"); } },
    onMessage: async () => { throw new Error("must not execute"); },
  });
  assert.equal((await broken.dispatch(message())).status, "rate_limited");
  await broken.stop();
});

test("session keys isolate platform, user and conversation without separator collisions", () => {
  const base = message().identity;
  assert.notEqual(messagingSessionKey(base), messagingSessionKey({ ...base, userId: "u2" }));
  assert.notEqual(messagingSessionKey(base), messagingSessionKey({ ...base, platform: "discord" }));
  assert.notEqual(messagingSessionKey(base), messagingSessionKey({ ...base, conversationId: "conv2" }));
  assert.notEqual(messagingSessionKey({ ...base, userId: "a|b" }), messagingSessionKey({ ...base, userId: "a", conversationId: "b|conv1" }));
});
test("Telegram webhook secret check fails closed", () => {
  assert.equal(verifyTelegramWebhookSecret("secret", "secret"), true);
  assert.equal(verifyTelegramWebhookSecret("wrong", "secret"), false);
  assert.equal(verifyTelegramWebhookSecret(undefined, "secret"), false);
});
test("Discord signature verifier rejects missing, malformed and stale requests", () => {
  assert.equal(verifyDiscordRequest({ publicKeyHex: undefined, signatureHex: undefined, timestamp: undefined, rawBody: Buffer.from("{}") }), false);
  assert.equal(verifyDiscordRequest({ publicKeyHex: "x", signatureHex: "x", timestamp: "1", rawBody: Buffer.from("{}") }), false);
});
test("message chunking respects limits and preserves meaningful text", () => {
  const text = "first line\n" + "x".repeat(90) + "\nlast";
  const chunks = splitMessage(text, 40);
  assert.ok(chunks.every((chunk) => chunk.length <= 40));
  assert.equal(chunks.join(""), text);
});

test("gateway correlates Discord replies to their deferred interaction", async () => {
  const outbound: Array<{ conversationId: string; text: string; interactionId?: string }> = [];
  const discord: MessagingAdapter = {
    platform: "discord",
    async start() {},
    async stop() {},
    async send(input) {
      outbound.push(input);
      return { state: "sent" };
    },
  };
  const gateway = createMessagingGateway({
    enabled: true,
    adapters: [discord],
    allowUser: () => true,
    onMessage: async () => "reply",
  });
  const discordMessage = message({
    platform: "discord",
    messageId: "interaction-42",
    identity: { platform: "discord", userId: "u1", channelId: "c1", conversationId: "c1" },
  });
  assert.equal((await gateway.dispatch(discordMessage)).status, "handled");
  assert.equal(outbound[0]?.interactionId, "interaction-42");
  await gateway.stop();
});

test("gateway refuses oversized normalized messages before handler execution", async () => {
  let called = false;
  const gateway = createMessagingGateway({
    enabled: true,
    adapters: [adapter()],
    allowUser: () => true,
    onMessage: async () => { called = true; },
  });
  assert.equal((await gateway.dispatch(message({ text: "x".repeat(100_001) }))).status, "forbidden");
  assert.equal(called, false);
  await gateway.stop();
});

test("gateway does not pretend a failed startup can be restarted with an aborted signal", async () => {
  const broken: MessagingAdapter = {
    platform: "telegram",
    async start() { throw new Error("transport failed"); },
    async stop() {},
    async send() { return { state: "sent" }; },
  };
  const gateway = createMessagingGateway({ enabled: true, adapters: [broken], allowUser: () => true, onMessage: async () => "reply" });
  await assert.rejects(() => gateway.start(), /transport failed/);
  assert.equal((await gateway.dispatch(message())).status, "disabled");
});


test("gateway restart fences stale adapter callbacks and resumes with a fresh generation", async () => {
  const callbacks: Array<(message: InboundMessage) => Promise<void>> = [];
  let starts = 0;
  const sent: string[] = [];
  const restartable: MessagingAdapter = {
    platform: "telegram",
    async start(_signal, onMessage) { starts++; callbacks.push(onMessage); },
    async stop() {},
    async send(input) { sent.push(input.text); return { state: "sent" }; },
  };
  let handled = 0;
  const gateway = createMessagingGateway({
    enabled: true,
    adapters: [restartable],
    allowUser: () => true,
    onMessage: async () => { handled++; return "ok"; },
  });
  assert.equal(gateway.getStatus(), "idle");
  await gateway.start();
  assert.equal(gateway.getStatus(), "running");
  const oldCallback = callbacks[0]!;
  await gateway.restart();
  assert.equal(starts, 2);
  assert.equal(gateway.getStatus(), "running");
  await oldCallback(message({ messageId: "stale" }));
  assert.equal(handled, 0);
  await callbacks[1]!(message({ messageId: "fresh" }));
  assert.equal(handled, 1);
  assert.deepEqual(sent, ["ok"]);
  await gateway.stop();
  assert.equal(gateway.getStatus(), "stopped");
});

test("gateway reports outbound delivery failure after Telegram polling conflict stops transport", async () => {
  const token = "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
  let pollConflictResolve!: () => void;
  const pollConflict = new Promise<void>((resolve) => { pollConflictResolve = resolve; });
  let pollAttempts = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/getWebhookInfo")) {
      return new Response(JSON.stringify({ ok: true, result: { url: "" } }), { status: 200 });
    }
    if (url.endsWith("/getUpdates")) {
      pollAttempts += 1;
      return new Response(JSON.stringify({
        ok: false,
        description: "Conflict: terminated by other getUpdates request",
      }), { status: 409 });
    }
    throw new Error("Unexpected Telegram endpoint.");
  };
  const transport = createTelegramHttpTransport({
    token,
    fetchImpl,
    onError(event) {
      if (event === "poll_conflict") pollConflictResolve();
    },
  });
  const gateway = createMessagingGateway({
    enabled: true,
    adapters: [createTelegramAdapter(transport)],
    allowUser: () => true,
    onMessage: async () => "unused",
  });

  await gateway.start();
  await Promise.race([
    pollConflict,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Timed out waiting for Telegram poll conflict")), 1_000)),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(gateway.getStatus(), "running");
  assert.equal(await gateway.send("telegram", { conversationId: "chat-1", text: "must not be reported as sent" }), false);
  assert.equal(pollAttempts, 1);

  await gateway.stop();
  assert.equal(gateway.getStatus(), "stopped");
});
