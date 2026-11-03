import test from "node:test";
import assert from "node:assert/strict";
import { VoiceWorkflow } from "../src/voice/workflow.js";
import { createTelegramVoiceMessageHandler } from "../src/integrations/messaging/telegram-voice-handler.js";

const message = {
  updateId: 10, messageId: "55", userId: "123", conversationId: "-1009",
  fileId: "file_abc", mimeType: "audio/ogg", fileSizeBytes: 3,
  durationMs: 999_000, receivedAt: 1_000,
};

function setup(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const workflow = new VoiceWorkflow(
    { async transcribe(input) { calls.push("stt:" + input.durationMs + ":" + input.mimeType); return "hello"; } },
    async (transcript) => { calls.push("agent:" + transcript); if (overrides.agentFailure) throw new Error("agent failed"); return { text: "Hi there" }; },
    { async synthesize() { calls.push("tts"); return { bytes: new Uint8Array([8, 9]), mimeType: "audio/mpeg" }; } },
  );
  let claimed = false;
  const media = {
    async downloadVoice() { calls.push("download"); return { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/ogg" }; },
    async sendVoice(_chat: string, audio: { bytes: Uint8Array }) { calls.push("sendVoice:" + audio.bytes.length); },
    ...((overrides.media ?? {}) as object),
  };
  const handler = createTelegramVoiceMessageHandler({
    media,
    inspector: {
      async inspect() { calls.push("inspect"); return { mimeType: "audio/ogg", durationMs: 2_500 }; },
      ...((overrides.inspector ?? {}) as object),
    },
    workflow,
    accessPolicy: {
      async isAllowed() { calls.push("authorize"); return overrides.allowed !== false; },
    },
    deduplicator: {
      async claim(key: string) { calls.push("claim:" + key); if (overrides.duplicate) return false; if (claimed) return false; claimed = true; return true; },
      async release(key: string) { calls.push("release:" + key); claimed = false; },
    },
    async sendText() { calls.push("sendText"); },
    ...(overrides.replyMode ? { replyMode: overrides.replyMode as "text" | "audio" | "both" } : {}),
  });
  return { handler, calls };
}

test("Telegram voice authorizes and claims before download, inspects real media, then runs workflow and replies", async () => {
  const { handler, calls } = setup();
  assert.equal(await handler(message, new AbortController().signal), "processed");
  assert.deepEqual(calls.slice(0, 5).map(x => x.split(":")[0]), ["authorize", "claim", "download", "inspect", "stt"]);
  assert.ok(calls.includes("stt:2500:audio/ogg"));
  assert.ok(calls.includes("sendText"));
  assert.ok(calls.includes("sendVoice:2"));
  assert.equal(calls.some(x => x.includes("999000")), false);
});

test("unauthorized Telegram voice is rejected before dedupe claim or media download", async () => {
  const { handler, calls } = setup({ allowed: false });
  assert.equal(await handler(message, new AbortController().signal), "forbidden");
  assert.deepEqual(calls, ["authorize"]);
});

test("duplicate Telegram voice is rejected before media download", async () => {
  const { handler, calls } = setup({ duplicate: true });
  assert.equal(await handler(message, new AbortController().signal), "duplicate");
  assert.equal(calls.some(x => x === "download"), false);
});

test("Telegram voice rejects decoder results with invalid duration or MIME before STT", async () => {
  const { handler, calls } = setup({
    inspector: { async inspect() { return { mimeType: "application/octet-stream", durationMs: 2500 }; } },
  });
  await assert.rejects(handler(message, new AbortController().signal), /failed audio inspection/);
  assert.equal(calls.some(x => x.startsWith("stt:")), false);
});

test("Telegram voice can deliver text only without sending synthesized audio", async () => {
  const { handler, calls } = setup({ replyMode: "text" });
  assert.equal(await handler(message, new AbortController().signal), "processed");
  assert.ok(calls.includes("sendText"));
  assert.equal(calls.some(x => x.startsWith("sendVoice:")), false);
});

test("Telegram voice releases its dedupe claim when download or inspection fails before agent execution", async () => {
  const download = setup({ media: { async downloadVoice() { throw new Error("temporary download failure"); } } });
  await assert.rejects(download.handler(message, new AbortController().signal), /temporary download failure/);
  assert.equal(download.calls.some((x) => x.startsWith("release:")), true);

  const inspection = setup({ inspector: { async inspect() { throw new Error("decoder unavailable"); } } });
  await assert.rejects(inspection.handler(message, new AbortController().signal), /decoder unavailable/);
  assert.equal(inspection.calls.some((x) => x.startsWith("release:")), true);
});

test("Telegram voice retains its dedupe claim after agent execution begins", async () => {
  const { handler, calls } = setup({ agentFailure: true });
  await assert.rejects(handler(message, new AbortController().signal), /agent failed/);
  assert.ok(calls.some((x) => x.startsWith("agent:")));
  assert.equal(calls.some((x) => x.startsWith("release:")), false);
});
