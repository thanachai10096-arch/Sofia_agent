import assert from "node:assert/strict";
import test from "node:test";
import { createDiscordGatewayTransport } from "./discord-gateway-transport.js";

class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static latest: FakeSocket | undefined;
  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  constructor(_url: string) {
    super();
    FakeSocket.latest = this;
    queueMicrotask(() => { this.readyState = FakeSocket.OPEN; this.dispatchEvent(new Event("open")); });
  }
  send(value: string) { this.sent.push(value); }
  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    const event = Object.assign(new Event("close"), { code: 1000 });
    this.dispatchEvent(event);
  }
  server(payload: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) })); }
}
const WebSocketFake = FakeSocket as unknown as typeof WebSocket;
const token = "a".repeat(60);

test("Discord Gateway identifies with minimum guild/message-content intents and routes ordinary guild messages", async () => {
  const controller = new AbortController();
  const received: Array<{ id: string; content: string }> = [];
  const transport = createDiscordGatewayTransport({ botToken: token, WebSocketImpl: WebSocketFake });
  await transport.start(controller.signal, async (message) => { received.push({ id: message.id, content: message.content }); });
  const socket = FakeSocket.latest!;
  await new Promise((resolve) => setImmediate(resolve));
  socket.server({ op: 10, d: { heartbeat_interval: 60_000 } });
  const identify = socket.sent.map((item) => JSON.parse(item)).find((item) => item.op === 2);
  assert.equal(identify.d.intents, (1 << 9) | (1 << 15));
  socket.server({ op: 0, t: "READY", s: 1, d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg/" , user: { id: "bot-id" } } });
  socket.server({ op: 0, t: "MESSAGE_CREATE", s: 2, d: {
    id: "123456789", channel_id: "222222222", guild_id: "333333333",
    author: { id: "444444444", username: "member", bot: false },
    content: "สวัสดี Sofia", timestamp: "2026-11-07T10:00:00.000Z", attachments: [],
  } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [{ id: "123456789", content: "สวัสดี Sofia" }]);
  controller.abort();
  await transport.stop();
});

test("Discord Gateway ignores DMs, bot messages, and webhook messages", async () => {
  const controller = new AbortController();
  let received = 0;
  const transport = createDiscordGatewayTransport({ botToken: token, WebSocketImpl: WebSocketFake });
  await transport.start(controller.signal, async () => { received++; });
  const socket = FakeSocket.latest!;
  await new Promise((resolve) => setImmediate(resolve));
  socket.server({ op: 10, d: { heartbeat_interval: 60_000 } });
  socket.server({ op: 0, t: "READY", s: 1, d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg/", user: { id: "bot-id" } } });
  const base = { id: "1", channel_id: "2", author: { id: "3", bot: false }, content: "hi", timestamp: "2026-11-07T10:00:00.000Z" };
  socket.server({ op: 0, t: "MESSAGE_CREATE", s: 2, d: base });
  socket.server({ op: 0, t: "MESSAGE_CREATE", s: 3, d: { ...base, guild_id: "4", author: { id: "bot-id", bot: true } } });
  socket.server({ op: 0, t: "MESSAGE_CREATE", s: 4, d: { ...base, guild_id: "4", webhook_id: "5" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received, 0);
  controller.abort();
  await transport.stop();
});
