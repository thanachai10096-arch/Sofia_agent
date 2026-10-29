import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createSlackEventsTransport } from "./slack-events-transport.js";

const secret = "test-signing-secret-with-sufficient-length";
const token = "xoxb-" + "a".repeat(30);
function signed(body: string, timestamp = String(Math.floor(1_710_000_000))) {
  const signature = "v0=" + createHmac("sha256", secret).update("v0:" + timestamp + ":" + body).digest("hex");
  return { headers: { "x-slack-signature": signature, "x-slack-request-timestamp": timestamp }, rawBody: Buffer.from(body) };
}
const fixedNow = 1_710_000_000_000;

test("Slack Events transport verifies the exact raw body and rejects stale/invalid signatures", async () => {
  const transport = createSlackEventsTransport({ signingSecret: secret, botToken: token, now: () => fixedNow });
  await transport.start(new AbortController().signal, async () => {});
  const valid = signed(JSON.stringify({ type: "url_verification", challenge: "challenge-123" }));
  assert.deepEqual(await transport.handleRequest(valid), { status: 200, body: { challenge: "challenge-123" } });
  assert.equal((await transport.handleRequest({ ...valid, rawBody: Buffer.from("{}") })).status, 401);
  const stale = signed("{}", String(Math.floor(fixedNow / 1000) - 301));
  assert.equal((await transport.handleRequest(stale)).status, 401);
  await transport.stop();
});

test("Slack Events transport normalizes verified human messages and deduplicates event retries", async () => {
  const transport = createSlackEventsTransport({ signingSecret: secret, botToken: token, now: () => fixedNow });
  const received: Array<{ userId: string; channelId: string; text: string }> = [];
  await transport.start(new AbortController().signal, async (message) => {
    received.push({ userId: message.userId, channelId: message.channelId, text: message.text });
  });
  const body = JSON.stringify({ type: "event_callback", event_id: "Ev-123", event: {
    type: "message", user: "U123", channel: "C123", ts: "1710000000.0001", text: "hello Sofia",
  } });
  assert.deepEqual(await transport.handleRequest(signed(body)), { status: 200, body: { ok: true } });
  assert.deepEqual(await transport.handleRequest(signed(body)), { status: 200, body: { ok: true, duplicate: true } });
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], { userId: "U123", channelId: "C123", text: "hello Sofia" });
  await transport.stop();
});

test("Slack Events transport sends outbound messages with its server-side token and safe failures", async () => {
  const requests: Array<{ url: string; authorization?: string; body: string }> = [];
  const transport = createSlackEventsTransport({
    signingSecret: secret, botToken: token,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") ?? undefined, body: String(init?.body) });
      return new Response(JSON.stringify({ ok: true, ts: "1710000000.0002" }), { status: 200 });
    },
  });
  await transport.start(new AbortController().signal, async () => {});
  assert.deepEqual(await transport.postMessage("C123", "hello", "1710000000.0001"), { messageId: "1710000000.0002" });
  assert.equal(requests[0]?.authorization, "Bearer " + token);
  assert.match(requests[0]?.body ?? "", /thread_ts/);
  await transport.stop();
});
