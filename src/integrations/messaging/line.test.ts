import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { createLineHttpTransport, verifyLineSignature } from "./line-http-transport.js";
import { createLineAdapter } from "./line.js";

const secret = "test-channel-secret";
const signed = (body: string) => createHmac("sha256", secret).update(body).digest("base64");

test("LINE signature verifier uses exact raw body and fails closed", () => {
  const body = Buffer.from(JSON.stringify({ events: [] }));
  const signature = signed(body.toString("utf8"));
  assert.equal(verifyLineSignature({ channelSecret: secret, signature, rawBody: body }), true);
  assert.equal(verifyLineSignature({ channelSecret: secret, signature, rawBody: Buffer.from("{}") }), false);
  assert.equal(verifyLineSignature({ channelSecret: secret, signature: undefined, rawBody: body }), false);
  assert.equal(verifyLineSignature({ channelSecret: undefined, signature, rawBody: body }), false);
});

test("LINE webhook rejects invalid signatures before parsing or dispatch", async () => {
  const transport = createLineHttpTransport({ channelAccessToken: "test-token", channelSecret: secret });
  const events: unknown[] = [];
  await transport.start(new AbortController().signal, async (event) => { events.push(event); });
  const result = await transport.handleWebhook(Buffer.from("not-json"), "invalid");
  assert.deepEqual(result, { status: 401, acceptedEvents: 0 });
  assert.equal(events.length, 0);
  await transport.stop();
});

test("LINE webhook maps verified text events to trusted user and conversation IDs", async () => {
  const transport = createLineHttpTransport({ channelAccessToken: "test-token", channelSecret: secret });
  const received: Array<{ userId: string; conversationId: string; text: string }> = [];
  await transport.start(new AbortController().signal, async (event) => {
    received.push({ userId: event.userId, conversationId: event.conversationId, text: event.text });
  });
  const body = JSON.stringify({ events: [{
    type: "message", webhookEventId: "evt-1", timestamp: 123456,
    source: { type: "group", userId: "user-1", groupId: "group-1" },
    message: { id: "msg-1", type: "text", text: "hello Sofia" },
  }] });
  const result = await transport.handleWebhook(Buffer.from(body), signed(body));
  assert.deepEqual(result, { status: 200, acceptedEvents: 1 });
  assert.deepEqual(received, [{ userId: "user-1", conversationId: "group-1", text: "hello Sofia" }]);
  await transport.stop();
});

test("LINE adapter sends replies through the shared adapter contract", async () => {
  const sent: Array<{ conversationId: string; text: string }> = [];
  const transport = {
    async start(_signal: AbortSignal, onMessage: (event: any) => Promise<void>) {
      await onMessage({ signatureVerified: true, webhookEventId: "evt", messageId: "msg", userId: "u1", conversationId: "c1", text: "hi", timestamp: 1 });
    },
    async pushMessage(conversationId: string, text: string) {
      sent.push({ conversationId, text });
      return { messageId: "line-message-1" };
    },
    async stop() {},
  };
  const adapter = createLineAdapter(transport);
  const received: Array<{ platform: string; userId: string; text: string }> = [];
  await adapter.start(new AbortController().signal, async (message) => {
    received.push({ platform: message.platform, userId: message.identity.userId, text: message.text });
  });
  assert.deepEqual(received, [{ platform: "line", userId: "u1", text: "hi" }]);
  assert.deepEqual(await adapter.send({ conversationId: "c1", text: "reply" }), { state: "sent", providerMessageId: "line-message-1" });
  assert.deepEqual(sent, [{ conversationId: "c1", text: "reply" }]);
  await adapter.stop();
});
