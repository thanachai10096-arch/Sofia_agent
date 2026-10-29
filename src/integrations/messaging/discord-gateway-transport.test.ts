import assert from "node:assert/strict";
import test from "node:test";
import { createDiscordGatewayTransport, type DiscordGatewaySocket } from "./discord-gateway-transport.js";

class FakeSocket implements DiscordGatewaySocket {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  private listeners = new Map<string, Array<(event: { data?: unknown; code?: number; reason?: string }) => void>>();
  send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(): void { this.readyState = 3; this.emit("close", { code: 1000 }); }
  addEventListener(type: string, listener: (event: { data?: unknown; code?: number; reason?: string }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type: string, event: { data?: unknown; code?: number; reason?: string } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  gateway(payload: Record<string, unknown>): void { this.emit("message", { data: JSON.stringify(payload) }); }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("Discord Gateway identifies, ignores ordinary group chatter, and marks exact bot mentions", async () => {
  const socket = new FakeSocket();
  const delivered: Array<{ content: string; directMessage?: boolean; addressedToBot?: boolean; transportVerified?: true }> = [];
  const transport = createDiscordGatewayTransport({
    botToken: "x".repeat(30),
    socketFactory: () => socket,
    fetchImpl: async () => new Response(JSON.stringify({ id: "outgoing-message" }), { status: 200 }),
  });
  await transport.start(new AbortController().signal, async (message) => {
    delivered.push({
      content: message.content,
      directMessage: message.directMessage,
      addressedToBot: message.addressedToBot,
      transportVerified: message.transportVerified,
    });
  });
  socket.gateway({ op: 10, d: { heartbeat_interval: 60_000 } });
  const identify = socket.sent.find((payload) => payload.op === 2);
  assert.ok(identify);
  assert.equal((identify.d as { intents: number }).intents & (1 << 15), 1 << 15);
  socket.gateway({ op: 0, t: "READY", s: 1, d: { session_id: "session-1", resume_gateway_url: "wss://gateway.discord.gg", user: { id: "999", username: "Sofia" } } });
  socket.gateway({ op: 0, t: "MESSAGE_CREATE", s: 2, d: {
    id: "101", channel_id: "202", guild_id: "303", content: "ordinary group chat",
    author: { id: "404", username: "user", bot: false }, mentions: [],
  } });
  socket.gateway({ op: 0, t: "MESSAGE_CREATE", s: 3, d: {
    id: "102", channel_id: "202", guild_id: "303", content: "<@999> help me",
    author: { id: "404", username: "user", bot: false }, mentions: [{ id: "999" }],
  } });
  await tick();
  assert.deepEqual(delivered, [{
    content: "ordinary group chat", directMessage: false, addressedToBot: undefined, transportVerified: true,
  }, {
    content: "help me", directMessage: false, addressedToBot: true, transportVerified: true,
  }]);
  await transport.stop();
});

test("Discord Gateway marks only one-to-one DM channels as direct messages", async () => {
  const socket = new FakeSocket();
  const delivered: Array<{ directMessage?: boolean; addressedToBot?: boolean }> = [];
  const transport = createDiscordGatewayTransport({
    botToken: "x".repeat(30),
    socketFactory: () => socket,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/channels/202")) return new Response(JSON.stringify({ type: 1 }), { status: 200 });
      return new Response(JSON.stringify({ id: "outgoing-message" }), { status: 200 });
    },
  });
  await transport.start(new AbortController().signal, async (message) => {
    delivered.push({ directMessage: message.directMessage, addressedToBot: message.addressedToBot });
  });
  socket.gateway({ op: 10, d: { heartbeat_interval: 60_000 } });
  socket.gateway({ op: 0, t: "READY", s: 1, d: { session_id: "session-1", user: { id: "999", username: "Sofia" } } });
  socket.gateway({ op: 0, t: "MESSAGE_CREATE", s: 2, d: {
    id: "101", channel_id: "202", content: "hello",
    author: { id: "404", username: "user", bot: false },
  } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(delivered, [{ directMessage: true, addressedToBot: undefined }]);
  await transport.stop();
});

test("Discord Gateway ignores an untrusted resume URL and reconnects only to the official gateway", async () => {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const transport = createDiscordGatewayTransport({
    botToken: "x".repeat(30),
    socketFactory: (url) => {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    fetchImpl: async () => new Response(JSON.stringify({ id: "outgoing-message" }), { status: 200 }),
  });
  await transport.start(new AbortController().signal, async () => {});
  const first = sockets[0];
  assert.ok(first);
  first.gateway({ op: 10, d: { heartbeat_interval: 60_000 } });
  first.gateway({ op: 0, t: "READY", s: 1, d: {
    session_id: "session-1",
    resume_gateway_url: "wss://attacker.example.invalid",
    user: { id: "999", username: "Sofia" },
  } });
  first.gateway({ op: 7 });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(urls.length, 2);
  assert.equal(urls[1], "wss://gateway.discord.gg/?v=10&encoding=json");
  await transport.stop();
});
