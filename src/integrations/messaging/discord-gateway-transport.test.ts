import assert from "node:assert/strict";
import test from "node:test";
import { createDiscordGatewayTransport, type DiscordGatewaySocket } from "./discord-gateway-transport.js";

class FakeSocket implements DiscordGatewaySocket {
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  on(event: "open" | "message" | "close" | "error", listener: (...args: never[]) => void): this {
    const current = this.listeners.get(event) ?? [];
    current.push(listener as (...args: unknown[]) => void);
    this.listeners.set(event, current);
    return this;
  }
  send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(code = 1000, reason = ""): void { this.emit("close", code, reason); }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

const token = "BotToken_1234567890.abcdef-XYZ";
const baseOptions = {
  botToken: token,
  allowedUserIds: ["111111111111"],
  allowedChannelIds: ["222222222222"],
  random: () => 0.5,
};

test("Discord Gateway identifies only after Hello and requests minimum required intents", async () => {
  const sockets: FakeSocket[] = [];
  const transport = createDiscordGatewayTransport({
    ...baseOptions,
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
  });
  await transport.start(new AbortController().signal, async () => {});
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0]?.sent.length, 0);
  sockets[0]?.emit("message", JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
  assert.deepEqual(sockets[0]?.sent[0], {
    op: 2,
    d: {
      token,
      intents: 33_281,
      properties: { os: process.platform, browser: "sofia-agent", device: "sofia-agent" },
    },
  });
  await transport.stop();
});

test("Discord Gateway dispatches only allowlisted human messages and deduplicates replayed events", async () => {
  const sockets: FakeSocket[] = [];
  const received: Array<{ id: string; content: string }> = [];
  const transport = createDiscordGatewayTransport({
    ...baseOptions,
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
  });
  await transport.start(new AbortController().signal, async (message) => {
    received.push({ id: message.id, content: message.content });
  });
  const socket = sockets[0];
  socket?.emit("message", JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
  socket?.emit("message", JSON.stringify({
    op: 0, s: 1, t: "READY",
    d: { session_id: "session-1", resume_gateway_url: "wss://gateway.discord.gg" },
  }));
  const allowed = {
    op: 0, s: 2, t: "MESSAGE_CREATE",
    d: {
      id: "333333333333", channel_id: "222222222222", content: "ช่วยตรวจโค้ด",
      timestamp: "2026-11-03T10:00:00.000Z",
      author: { id: "111111111111", username: "tester", bot: false },
      attachments: [{ id: "444444444444", filename: "notes.txt", size: 12 }],
    },
  };
  socket?.emit("message", JSON.stringify(allowed));
  socket?.emit("message", JSON.stringify(allowed));
  socket?.emit("message", JSON.stringify({
    op: 0, s: 3, t: "MESSAGE_CREATE",
    d: { id: "555555555555", channel_id: "222222222222", content: "not allowed", author: { id: "999999999999" } },
  }));
  socket?.emit("message", JSON.stringify({
    op: 0, s: 4, t: "MESSAGE_CREATE",
    d: { id: "666666666666", channel_id: "222222222222", content: "bot message", author: { id: "111111111111", bot: true } },
  }));
  for (let attempt = 0; attempt < 20 && received.length === 0; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(received, [{ id: "333333333333", content: "ช่วยตรวจโค้ด" }]);
  await transport.stop();
});

test("Discord Gateway rejects missing or malformed allowlists", () => {
  assert.throws(() => createDiscordGatewayTransport({
    ...baseOptions, allowedUserIds: [], createSocket: () => new FakeSocket(),
  }), /non-empty valid user allowlist/);
  assert.throws(() => createDiscordGatewayTransport({
    ...baseOptions, allowedChannelIds: ["*"], createSocket: () => new FakeSocket(),
  }), /non-empty valid channel allowlist/);
});

test("Discord Gateway sends messages through the bot REST API without exposing credentials", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const transport = createDiscordGatewayTransport({
    ...baseOptions,
    createSocket: () => new FakeSocket(),
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ id: "777777777777" }), { status: 200 });
    },
  });
  await transport.start(new AbortController().signal, async () => {});
  const receipt = await transport.sendMessage("222222222222", "Sofia reply", "333333333333");
  assert.deepEqual(receipt, { messageId: "777777777777" });
  assert.equal(requests[0]?.url, "https://discord.com/api/v10/channels/222222222222/messages");
  assert.equal((requests[0]?.init?.headers as Record<string, string>).authorization, `Bot ${token}`);
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    content: "Sofia reply",
    message_reference: { message_id: "333333333333", fail_if_not_exists: false },
  });
  await transport.stop();
});
