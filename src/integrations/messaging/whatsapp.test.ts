import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { createWhatsAppHttpTransport, verifyWhatsAppSignature, verifyWhatsAppWebhookChallenge } from "./whatsapp-http-transport.js";
import { createWhatsAppAdapter, type VerifiedWhatsAppMessage } from "./whatsapp.js";
import { createWhatsAppMessagingRuntime } from "./whatsapp-runtime.js";

const appSecret = "test-meta-app-secret";
const signed = (body: string) => "sha256=" + createHmac("sha256", appSecret).update(body).digest("hex");
const options = {
  accessToken: "test-access-token",
  appSecret,
  verifyToken: "test-verify-token",
  phoneNumberId: "12345678901",
  graphApiVersion: "v99.0",
};

test("WhatsApp signature verifier uses raw bytes and rejects malformed signatures", () => {
  const body = Buffer.from('{"entry":[]}');
  assert.equal(verifyWhatsAppSignature({ appSecret, signature: signed(body.toString()), rawBody: body }), true);
  assert.equal(verifyWhatsAppSignature({ appSecret, signature: signed(body.toString()), rawBody: Buffer.from("{}") }), false);
  assert.equal(verifyWhatsAppSignature({ appSecret, signature: "sha256=bad", rawBody: body }), false);
  assert.equal(verifyWhatsAppSignature({ appSecret: undefined, signature: signed(body.toString()), rawBody: body }), false);
});

test("WhatsApp GET challenge requires exact verification token", () => {
  assert.equal(verifyWhatsAppWebhookChallenge({ mode: "subscribe", token: "verify", challenge: "abc", verifyToken: "verify" }), "abc");
  assert.equal(verifyWhatsAppWebhookChallenge({ mode: "subscribe", token: "wrong", challenge: "abc", verifyToken: "verify" }), undefined);
  assert.equal(verifyWhatsAppWebhookChallenge({ mode: "other", token: "verify", challenge: "abc", verifyToken: "verify" }), undefined);
});

test("WhatsApp webhook rejects invalid signatures before parsing or dispatch", async () => {
  const transport = createWhatsAppHttpTransport(options);
  const events: unknown[] = [];
  await transport.start(new AbortController().signal, async (event) => { events.push(event); });
  assert.deepEqual(await transport.handleWebhook(Buffer.from("not-json"), "sha256=bad"), { status: 401, acceptedEvents: 0 });
  assert.equal(events.length, 0);
  await transport.stop();
});

test("WhatsApp webhook dispatches only signed text messages for configured business phone", async () => {
  const transport = createWhatsAppHttpTransport(options);
  const received: Array<{ userId: string; phoneNumberId: string; text: string }> = [];
  await transport.start(new AbortController().signal, async (event) => {
    received.push({ userId: event.userId, phoneNumberId: event.phoneNumberId, text: event.text });
  });
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "business-1", changes: [{ field: "messages", value: {
      metadata: { phone_number_id: options.phoneNumberId },
      messages: [{ id: "wamid.1", from: "66812345678", timestamp: "1790000000", type: "text", text: { body: "hello Sofia" } }],
    } }] }],
  });
  assert.deepEqual(await transport.handleWebhook(Buffer.from(body), signed(body)), { status: 200, acceptedEvents: 1 });
  assert.deepEqual(received, [{ userId: "66812345678", phoneNumberId: options.phoneNumberId, text: "hello Sofia" }]);
  await transport.stop();
});

test("WhatsApp adapter maps identities and sends chunked replies via the shared contract", async () => {
  const sent: Array<{ recipient: string; text: string }> = [];
  const transport = {
    async start(_signal: AbortSignal, onMessage: (event: VerifiedWhatsAppMessage) => Promise<void>) {
      await onMessage({ signatureVerified: true, eventId: "entry-1", messageId: "msg-1", userId: "66812345678", phoneNumberId: options.phoneNumberId, text: "hi", timestamp: 1 });
    },
    async sendText(recipientId: string, text: string) { sent.push({ recipient: recipientId, text }); return { messageId: "wamid.out" }; },
    async stop() {},
  };
  const adapter = createWhatsAppAdapter(transport);
  const received: Array<{ platform: string; userId: string; conversationId: string }> = [];
  await adapter.start(new AbortController().signal, async (message) => {
    received.push({ platform: message.platform, userId: message.identity.userId, conversationId: message.identity.conversationId });
  });
  assert.deepEqual(received, [{ platform: "whatsapp", userId: "66812345678", conversationId: "66812345678" }]);
  assert.deepEqual(await adapter.send({ conversationId: "66812345678", text: "reply" }), { state: "sent", providerMessageId: "wamid.out" });
  assert.deepEqual(sent, [{ recipient: "66812345678", text: "reply" }]);
  await adapter.stop();
});

test("WhatsApp transport validates explicit Graph API version and configured phone ID", () => {
  assert.throws(() => createWhatsAppHttpTransport({ ...options, graphApiVersion: "latest" }), /version/);
  assert.throws(() => createWhatsAppHttpTransport({ ...options, phoneNumberId: "not-a-number" }), /phone number ID/);
});

test("WhatsApp runtime remains disabled by default and fails closed without allowlists", () => {
  const warnings: string[] = [];
  assert.equal(createWhatsAppMessagingRuntime({}, "/tmp/sofia-whatsapp-test", (warning) => warnings.push(warning)), undefined);
  assert.deepEqual(warnings, []);
  const runtime = createWhatsAppMessagingRuntime({
    SOFIA_WHATSAPP_ENABLED: "true",
    WHATSAPP_ACCESS_TOKEN: "token",
    WHATSAPP_APP_SECRET: "secret",
    WHATSAPP_VERIFY_TOKEN: "verify",
    WHATSAPP_PHONE_NUMBER_ID: "12345678901",
    WHATSAPP_GRAPH_API_VERSION: "v99.0",
    WHATSAPP_ALLOWED_USER_IDS: "66812345678",
    WHATSAPP_ALLOWED_CONVERSATION_IDS: "",
    SOFIA_API_KEY: "api-key",
    SOFIA_API_BASE_URL: "https://sofia.example",
  }, "/tmp/sofia-whatsapp-test", (warning) => warnings.push(warning));
  assert.equal(runtime, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /allowlists are required/);
});

test("WhatsApp runtime constructs only when all required settings are present", async () => {
  const runtime = createWhatsAppMessagingRuntime({
    SOFIA_WHATSAPP_ENABLED: "true",
    WHATSAPP_ACCESS_TOKEN: "token",
    WHATSAPP_APP_SECRET: "secret",
    WHATSAPP_VERIFY_TOKEN: "verify",
    WHATSAPP_PHONE_NUMBER_ID: "12345678901",
    WHATSAPP_GRAPH_API_VERSION: "v99.0",
    WHATSAPP_ALLOWED_USER_IDS: "66812345678",
    WHATSAPP_ALLOWED_CONVERSATION_IDS: "66812345678",
    SOFIA_API_KEY: "api-key",
    SOFIA_API_BASE_URL: "https://sofia.example",
  }, "/tmp/sofia-whatsapp-runtime-test", () => undefined);
  assert.ok(runtime);
  assert.equal(typeof runtime.webhookTransport.handleWebhook, "function");
  assert.equal(runtime.webhookTransport.verifyChallenge({ mode: "subscribe", token: "verify", challenge: "challenge" }), "challenge");
  await runtime.stop();
});
