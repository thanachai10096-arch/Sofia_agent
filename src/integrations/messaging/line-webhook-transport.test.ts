import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createLineWebhookTransport } from "./line-webhook-transport.js";

const secret = "line-channel-secret-for-tests";
const token = "line-channel-access-token-1234567890";
function signed(body: string) {
  return {
    headers: { "x-line-signature": createHmac("sha256", secret).update(body).digest("base64") },
    rawBody: Buffer.from(body),
  };
}

test("LINE webhook transport validates signature before parsing events", async () => {
  const transport = createLineWebhookTransport({ channelSecret: secret, channelAccessToken: token });
  await transport.start(new AbortController().signal, async () => {});
  const body = JSON.stringify({ events: [] });
  assert.deepEqual(await transport.handleRequest(signed(body)), { status: 200, body: { ok: true } });
  assert.equal((await transport.handleRequest({ ...signed(body), rawBody: Buffer.from("{}") })).status, 401);
  assert.equal((await transport.handleRequest({ headers: {}, rawBody: Buffer.from(body) })).status, 401);
  await transport.stop();
});

test("LINE webhook transport normalizes text events and de-duplicates redeliveries", async () => {
  const transport = createLineWebhookTransport({ channelSecret: secret, channelAccessToken: token, now: () => 1710000000000 });
  const received: Array<{ userId: string; conversationId: string; text: string }> = [];
  await transport.start(new AbortController().signal, async (message) => {
    received.push({ userId: message.userId, conversationId: message.conversationId, text: message.text });
  });
  const body = JSON.stringify({ events: [{
    type: "message", webhookEventId: "01HXYZ", timestamp: 1710000000000,
    source: { type: "group", userId: "U123", groupId: "C123" },
    message: { id: "M123", type: "text", text: "hello Sofia" },
  }] });
  assert.deepEqual(await transport.handleRequest(signed(body)), { status: 200, body: { ok: true } });
  assert.deepEqual(await transport.handleRequest(signed(body)), { status: 200, body: { ok: true } });
  assert.deepEqual(received, [{ userId: "U123", conversationId: "C123", text: "hello Sofia" }]);
  await transport.stop();
});

test("LINE push transport keeps token server-side and returns generic errors", async () => {
  let auth: string | null = null;
  const transport = createLineWebhookTransport({
    channelSecret: secret, channelAccessToken: token,
    fetchImpl: async (_url, init) => {
      auth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ sentMessages: [{ id: "line-msg-1" }] }), { status: 200 });
    },
  });
  await transport.start(new AbortController().signal, async () => {});
  assert.deepEqual(await transport.pushMessage("C123", "hello"), { messageId: "line-msg-1" });
  assert.equal(auth, "Bearer " + token);
  await transport.stop();
});
