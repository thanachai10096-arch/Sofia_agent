import test from "node:test";
import { createVoiceProviderRegistry, loadVoiceProviderSelectionFromEnv } from "../src/voice/provider-registry.js";
import assert from "node:assert/strict";
import { VoiceWorkflow } from "../src/voice/workflow.js";

const audio = { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/wav", durationMs: 1000 };

test("voice workflow transcribes, routes through agent callback, and optionally synthesizes", async () => {
  const calls: string[] = [];
  const workflow = new VoiceWorkflow(
    { async transcribe() { calls.push("stt"); return " hello Sofia "; } },
    async (transcript) => { calls.push("agent:" + transcript); return { text: "Hello back", value: { ok: true } }; },
    { async synthesize(text) { calls.push("tts:" + text); return { bytes: new Uint8Array([4, 5]), mimeType: "audio/mpeg" }; } },
  );
  const result = await workflow.processAudio(audio, new AbortController().signal);
  assert.deepEqual(calls, ["stt", "agent:hello Sofia", "tts:Hello back"]);
  assert.equal(result.transcript, "hello Sofia");
  assert.equal(result.replyText, "Hello back");
  assert.equal(result.audioReply?.mimeType, "audio/mpeg");
});

test("voice workflow validates MIME type, size, and duration before provider calls", async () => {
  let called = false;
  const workflow = new VoiceWorkflow({ async transcribe() { called = true; return "x"; } }, async () => ({ text: "reply" }));
  await assert.rejects(workflow.processAudio({ ...audio, mimeType: "application/octet-stream" }, new AbortController().signal), /MIME type/);
  await assert.rejects(workflow.processAudio({ ...audio, durationMs: 999_999 }, new AbortController().signal), /duration/);
  assert.equal(called, false);
});

test("voice workflow rejects empty and oversized transcripts", async () => {
  const empty = new VoiceWorkflow({ async transcribe() { return "   "; } }, async () => ({ text: "reply" }));
  await assert.rejects(empty.processAudio(audio, new AbortController().signal), /empty transcript/);
  const large = new VoiceWorkflow({ async transcribe() { return "x".repeat(101); } }, async () => ({ text: "reply" }), undefined, { maxTranscriptChars: 100 });
  await assert.rejects(large.processAudio(audio, new AbortController().signal), /character limit/);
});

test("voice workflow supports text-only replies and respects cancellation", async () => {
  const workflow = new VoiceWorkflow({ async transcribe(_input, signal) { signal.throwIfAborted(); return "hi"; } }, async () => ({ text: "hello" }));
  const result = await workflow.processAudio(audio, new AbortController().signal);
  assert.equal(result.audioReply, undefined);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(workflow.processAudio(audio, controller.signal), /cancelled/);
});



test("voice provider registry is disabled by default and does not couple to model routing", () => {
  const registry = createVoiceProviderRegistry();
  registry.registerStt("mock-stt", { async transcribe() { return "hello"; } });
  assert.deepEqual(registry.resolve({ enabled: false }), { enabled: false });
  assert.deepEqual(loadVoiceProviderSelectionFromEnv({}), { enabled: false });
});

test("voice provider registry explicitly selects STT and optional TTS providers", () => {
  const registry = createVoiceProviderRegistry();
  const stt = { async transcribe() { return "hello"; } };
  const tts = { async synthesize() { return { bytes: new Uint8Array([1]), mimeType: "audio/mpeg" }; } };
  registry.registerStt("mock-stt", stt);
  registry.registerTts("mock-tts", tts);
  const textOnly = registry.resolve({ enabled: true, sttProviderId: "mock-stt" });
  assert.equal(textOnly.stt, stt);
  assert.equal(textOnly.tts, undefined);
  const withAudio = registry.resolve({ enabled: true, sttProviderId: "mock-stt", ttsProviderId: "mock-tts" });
  assert.equal(withAudio.stt, stt);
  assert.equal(withAudio.tts, tts);
  assert.deepEqual(registry.list(), { stt: ["mock-stt"], tts: ["mock-tts"] });
});

test("voice provider registry rejects missing, unknown, duplicate, and malformed provider IDs", () => {
  const registry = createVoiceProviderRegistry();
  const stt = { async transcribe() { return "hello"; } };
  assert.throws(() => registry.resolve({ enabled: true }), /no STT provider/);
  assert.throws(() => registry.resolve({ enabled: true, sttProviderId: "missing" }), /not registered/);
  assert.throws(() => registry.registerStt("../bad", stt), /provider ID/);
  registry.registerStt("mock-stt", stt);
  assert.throws(() => registry.registerStt("mock-stt", stt), /already registered/);
});

test("voice env configuration is explicit, validated, and never returns secret values", () => {
  assert.deepEqual(loadVoiceProviderSelectionFromEnv({
    SOFIA_VOICE_ENABLED: "true",
    SOFIA_VOICE_STT_PROVIDER: "stt-a",
    SOFIA_VOICE_TTS_PROVIDER: "tts-b",
    SOFIA_VOICE_STT_API_KEY: "do-not-return",
  }), { enabled: true, sttProviderId: "stt-a", ttsProviderId: "tts-b" });
  assert.throws(() => loadVoiceProviderSelectionFromEnv({ SOFIA_VOICE_ENABLED: "sometimes" }), /must be true\/false/);
  assert.throws(() => loadVoiceProviderSelectionFromEnv({ SOFIA_VOICE_ENABLED: "true" }), /requires SOFIA_VOICE_STT_PROVIDER/);
});
