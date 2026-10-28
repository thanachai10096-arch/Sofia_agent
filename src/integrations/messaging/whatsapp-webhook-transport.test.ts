import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createWhatsAppWebhookTransport } from "./whatsapp-webhook-transport.js";

const appSecret = "a".repeat(32);
const verifyToken = "verify-token-with-more-than-16-chars";
const accessToken = "EAA" + "x".repeat(40);
const options = {
  appSecret, verifyToken, accessToken, phoneNumberId: "123456789012345",
  graphApiVersion: "v23.0",
};
function signed(body: string) {
  return { method: "POST" as const, headers: {
    "x-hub-signature-256": "sha256=" + createHmac("sha256", appSecret).update(body).digest("hex"),
  }, rawBody: Buffer.from(body) };
}

test("WhatsApp webhook transport validates GET challenge and rejects wrong verification token", async () => {
  const transport = createWhatsAppWebhookTransport(options);
  assert.deepEqual(await transport.handleRequest({
    method: "GET", headers: {}, rawBody: new Uint8Array(),
    query: { mode: "subscribe", verifyToken, challenge: "challenge-123" },
  }), { status: 200, contentType: "text/plain; charset=utf-8", body: "challenge-123" });
  assert.equal((await transport.handleRequest({
    method: "GET", headers: {}, rawBody: new Uint8Array(),
    query: { mode: "subscribe", verifyToken: "wrong", challenge: "challenge-123" },
  })).status, 401);
});

test("WhatsApp webhook transport verifies raw body and normalizes allowlist-ready text events", async () => {
  const transport = createWhatsAppWebhookTransport(options,);
  const received: Array<{ senderPhoneId: string; text: string }> = [];
  await transport.start(new AbortController().signal, async (message) => {
    received.push({ senderPhoneId: message.senderPhoneId, text: message.text });
  });
  const body = JSON.stringify({ entry: [{ changes: [{ value: {
    metadata: { phone_number_id: options.phoneNumberId },
    messages: [{ id: "wamid.123", from: "66812345678", timestamp: "1710000000", type: "text", text: { body: "hello Sofia" } }],
  } }] }] });
  assert.deepEqual(await transport.handleRequest(signed(body)), { status: 200, body: { ok: true } });
  assert.deepEqual(await transport.handleRequest(signed(body)), { status: 200, body: { ok: true } });
  assert.deepEqual(received, [{ senderPhoneId: "66812345678", text: "hello Sofia" }]);
  assert.equal((await transport.handleRequest({ ...signed(body), rawBody: Buffer.from("{}") })).status, 401);
  await transport.stop();
});

test("WhatsApp outbound transport uses server-side bearer token and explicit Graph API version", async () => {
  let authorization: string | null = null;
  let url = "";
  const transport = createWhatsAppWebhookTransport({
    ...options,
    fetchImpl: async (input, init) => {
      url = String(input);
      authorization = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ messages: [{ id: "wamid.sent" }] }), { status: 200 });
    },
  });
  await transport.start(new AbortController().signal, async () => {});
  assert.deepEqual(await transport.sendMessage("66812345678", "hello"), { messageId: "wamid.sent" });
  assert.match(url, /v23\.0\/123456789012345\/messages$/);
  assert.equal(authorization, "Bearer " + accessToken);
  await transport.stop();
});
