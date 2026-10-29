import assert from "node:assert/strict";
import test from "node:test";
import { createDiscordGatewayTransport, type DiscordGatewaySocket } from "./discord-gateway-transport.js";

interface EventLike { data?: unknown; code?: number; reason?: string; }
class FakeSocket implements DiscordGatewaySocket {
  readonly readyState = 1;
  private readonly listeners = new Map<string, Set<(event: EventLike) => void>>();
  readonly sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
    const payload = JSON.parse(data) as { op: number };
    if (payload.op === 2) {
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({
        op: 0, s: 1, t: "READY", d: { session_id: "session-1", resume_gateway_url: "wss://gateway.discord.gg" },
      }) }));
    }
  }
  close(code = 1000, reason = "") {
    this.emit("close", { code, reason });
  }
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: EventLike) => void) {
    const bucket = this.listeners.get(type) ?? new Set();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }
  removeEventListener(type: "open" | "message" | "close" | "error", listener: (event: EventLike) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, event: EventLike = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

test("Discord Gateway transport identifies and forwards ordinary messages through the existing adapter contract", async () => {
  const socket = new FakeSocket();
  let received: { id: string; content: string; channelId: string; signatureVerified: true } | undefined;
  const transport = createDiscordGatewayTransport({
    botToken: "BotToken_1234567890.abcdef-XYZ",
    allowedUserIds: ["333333333333"],
    allowedChannelIds: ["123456789"],
    webSocketFactory: () => {
      queueMicrotask(() => socket.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }) }));
      return socket;
    },
    fetchImpl: async () => new Response(JSON.stringify({ id: "987654321" }), { status: 200 }),
  });

  await transport.start(new AbortController().signal, async (message) => {
    received = {
      id: message.id,
      content: message.content,
      channelId: message.channelId,
      signatureVerified: message.signatureVerified,
    };
  });

  const identify = socket.sent.map((entry) => JSON.parse(entry) as { op: number; d?: { intents?: number } }).find((entry) => entry.op === 2);
  assert.ok(identify);
  assert.equal(identify.d?.intents, (1 << 0) | (1 << 9) | (1 << 15));

  socket.emit("message", { data: JSON.stringify({
    op: 0, s: 2, t: "MESSAGE_CREATE", d: {
      id: "222222222222", channel_id: "123456789", content: "Hi Sofia",
      timestamp: "2026-10-28T12:00:00.000Z",
      author: { id: "333333333333", username: "tester", bot: false },
      attachments: [{ id: "444444444444", filename: "notes.txt", size: 12 }],
    },
  }) });
  for (let attempt = 0; attempt < 20 && !received; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(received, {
    id: "222222222222",
    content: "Hi Sofia",
    channelId: "123456789",
    signatureVerified: true,
  });

  const sent = await transport.sendMessage("123456789", "Hello back", "222222222222");
  assert.equal(sent.messageId, "987654321");
  await transport.stop();
});

test("Discord Gateway transport rejects invalid bot token and does not dispatch disallowed users", async () => {
  assert.throws(() => createDiscordGatewayTransport({ botToken: "bad" }), /token/);
  const socket = new FakeSocket();
  let dispatches = 0;
  const transport = createDiscordGatewayTransport({
    botToken: "BotToken_1234567890.abcdef-XYZ",
    allowedUserIds: ["allowed-user"],
    webSocketFactory: () => {
      queueMicrotask(() => socket.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }) }));
      return socket;
    },
  });
  await transport.start(new AbortController().signal, async () => { dispatches++; });
  socket.emit("message", { data: JSON.stringify({
    op: 0, s: 2, t: "MESSAGE_CREATE", d: {
      id: "222222222222", channel_id: "123456789", content: "not allowed",
      author: { id: "333333333333", bot: false },
    },
  }) });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(dispatches, 0);
  await transport.stop();
});

test("Discord Gateway startup aborts promptly before READY", async () => {
  const socket = new FakeSocket();
  const controller = new AbortController();
  const transport = createDiscordGatewayTransport({
    botToken: "BotToken_1234567890.abcdef-XYZ",
    webSocketFactory: () => socket,
  });
  const started = transport.start(controller.signal, async () => {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(started, /stopped before ready/);
});

test("Discord Gateway stops reconnecting when Discord rejects privileged intents", async () => {
  const socket = new FakeSocket();
  let reconnectAttempts = 0;
  const transport = createDiscordGatewayTransport({
    botToken: "BotToken_1234567890.abcdef-XYZ",
    reconnectBaseMs: 100,
    webSocketFactory: () => { reconnectAttempts++; return socket; },
  });
  const started = transport.start(new AbortController().signal, async () => {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  socket.emit("close", { code: 4014, reason: "disallowed intent" });
  await assert.rejects(started, /intents/);
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  assert.equal(reconnectAttempts, 1);
  await transport.stop();
});
