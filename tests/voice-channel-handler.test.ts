import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceChannelHandler } from "../src/voice/channel-handler.js";
import { VoiceWorkflow } from "../src/voice/workflow.js";

const audio = { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/wav", durationMs: 1000 };
const event = {
  channel: "telegram" as const,
  eventId: "evt-1",
  senderId: "user-1",
  conversationId: "chat-1",
  audio,
};

function setup(allowed = true) {
  const delivered: Array<{ text: string; audio?: { bytes: Uint8Array; mimeType: string } }> = [];
  const claimed = new Set<string>();
  const handler = createVoiceChannelHandler({
    workflow: new VoiceWorkflow(
      { async transcribe() { return "hello Sofia"; } },
      async (transcript) => ({ text: "You said: " + transcript }),
      { async synthesize() { return { bytes: new Uint8Array([9, 8]), mimeType: "audio/mpeg" }; } },
    ),
    accessPolicy: { isAllowed: async () => allowed },
    deduplicator: { claim: async (key) => {
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    } },
    delivery: { deliver: async (message) => {
      delivered.push({ text: message.text, ...(message.audio ? { audio: message.audio } : {}) });
    } },
  });
  return { handler, delivered };
}

test("voice channel handler routes authorized Telegram audio through the shared workflow", async () => {
  const { handler, delivered } = setup();
  const result = await handler(event, new AbortController().signal);
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  assert.equal(result.transcript, "hello Sofia");
  assert.equal(result.audioDelivered, true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.text, "You said: hello Sofia");
  assert.equal(delivered[0]?.audio?.mimeType, "audio/mpeg");
});

test("voice channel handler rejects unauthorized users before claiming or processing", async () => {
  const { handler, delivered } = setup(false);
  const result = await handler(event, new AbortController().signal);
  assert.deepEqual(result, { status: "forbidden" });
  assert.equal(delivered.length, 0);
});

test("voice channel handler deduplicates repeated platform events", async () => {
  const { handler, delivered } = setup();
  const first = await handler(event, new AbortController().signal);
  const second = await handler(event, new AbortController().signal);
  assert.equal(first.status, "accepted");
  assert.deepEqual(second, { status: "duplicate" });
  assert.equal(delivered.length, 1);
});

test("voice channel handler supports text-only reply mode", async () => {
  const { handler, delivered } = setup();
  const result = await handler({ ...event, eventId: "evt-2", replyMode: "text" }, new AbortController().signal);
  assert.equal(result.status, "accepted");
  assert.equal(delivered[0]?.audio, undefined);
  assert.equal(delivered[0]?.text, "You said: hello Sofia");
});

test("voice channel handler validates event identity before calling policy", async () => {
  const { handler } = setup();
  const malformed = { ...event, eventId: " ".repeat(1) };
  await assert.rejects(handler(malformed, new AbortController().signal), /eventId/);
});
