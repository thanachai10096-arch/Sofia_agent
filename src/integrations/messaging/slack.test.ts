import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifySlackRequest } from "./platform-security.js";
import { createSlackAdapter, type SlackTransport, type VerifiedSlackMessage } from "./slack.js";

test("Slack signature verifies exact raw body and rejects stale or altered requests", () => {
  const secret = "test-signing-secret";
  const timestamp = "1790000000";
  const body = Buffer.from('{"type":"event_callback","event":{"type":"message"}}');
  const signature = "v0=" + createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from("v0:" + timestamp + ":"), body]))
    .digest("hex");
  const nowMs = Number(timestamp) * 1000;
  assert.equal(verifySlackRequest({ signingSecret: secret, signature, timestamp, rawBody: body, nowMs }), true);
  assert.equal(verifySlackRequest({ signingSecret: secret, signature, timestamp, rawBody: Buffer.from("{}"), nowMs }), false);
  assert.equal(verifySlackRequest({ signingSecret: secret, signature, timestamp, rawBody: body, nowMs: nowMs + 600_001 }), false);
  assert.equal(verifySlackRequest({ signingSecret: secret, signature: "v0=bad", timestamp, rawBody: body, nowMs }), false);
});

test("Slack adapter maps verified messages and suppresses bot messages", async () => {
  let receive: ((event: VerifiedSlackMessage) => Promise<void>) | undefined;
  const sent: Array<{ channel: string; text: string; threadTs?: string }> = [];
  const transport: SlackTransport = {
    async start(_signal, onMessage) { receive = onMessage; },
    async postMessage(channel, text, threadTs) {
      sent.push({ channel, text, ...(threadTs ? { threadTs } : {}) });
      return { messageId: "reply-1" };
    },
    async stop() {},
  };
  const adapter = createSlackAdapter(transport);
  const messages: Array<{ platform: string; text: string; userId: string; messageId: string }> = [];
  await adapter.start(new AbortController().signal, async (message) => {
    messages.push({
      platform: message.platform,
      text: message.text,
      userId: message.identity.userId,
      messageId: message.messageId,
    });
  });
  assert.ok(receive);
  await receive!({ signatureVerified: true, eventId: "Ev1", channel: "C1", user: "U1", ts: "1790000000.000001", text: "hello" });
  await receive!({ signatureVerified: true, eventId: "Ev2", channel: "C1", user: "UBOT", botId: "B1", ts: "1790000001.000001", text: "bot echo" });
  assert.deepEqual(messages, [{ platform: "slack", text: "hello", userId: "U1", messageId: "Ev1:1790000000.000001" }]);
  assert.deepEqual(await adapter.send({ conversationId: "C1", text: "hello back", replyToMessageId: "1790000000.000001" }), {
    state: "sent", providerMessageId: "reply-1",
  });
  assert.deepEqual(sent, [{ channel: "C1", text: "hello back", threadTs: "1790000000.000001" }]);
  await adapter.stop();
});
