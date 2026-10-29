import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAICompatibleVoiceProviders } from "../src/voice/openai-compatible-provider.js";

function mockResponse(body: string | Uint8Array, status = 200, contentType = "application/json"): Response {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return new Response(bytes, { status, headers: { "content-type": contentType, "content-length": String(bytes.byteLength) } });
}

test("OpenAI-compatible voice STT sends audio to configured endpoint and parses transcript", async () => {
  let capturedUrl = "";
  let capturedAuth = "";
  let capturedModel = "";
  const providers = createOpenAICompatibleVoiceProviders({
    baseUrl: "https://voice.example.test/v1/",
    apiKey: "test-secret",
    sttModel: "stt-model",
    fetchImpl: async (input, init) => {
      capturedUrl = String(input);
      capturedAuth = new Headers(init?.headers).get("authorization") ?? "";
      const form = init?.body as FormData;
      capturedModel = String(form.get("model"));
      assert.equal(form.get("response_format"), "json");
      assert.equal((form.get("file") as File).type, "audio/wav");
      return mockResponse(JSON.stringify({ text: "  hello Sofia  " }));
    },
  });
  const transcript = await providers.stt.transcribe(
    { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/wav", durationMs: 1000 },
    new AbortController().signal,
  );
  assert.equal(capturedUrl, "https://voice.example.test/v1/audio/transcriptions");
  assert.equal(capturedAuth, "Bearer test-secret");
  assert.equal(capturedModel, "stt-model");
  assert.equal(transcript, "  hello Sofia  ");
});

test("OpenAI-compatible voice TTS returns bounded audio bytes and content type", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const providers = createOpenAICompatibleVoiceProviders({
    baseUrl: "https://voice.example.test/v1",
    apiKey: "test-secret",
    sttModel: "stt-model",
    ttsModel: "tts-model",
    ttsVoice: "voice-a",
    fetchImpl: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return mockResponse(new Uint8Array([0x49, 0x44, 0x33]), 200, "audio/mpeg");
    },
  });
  assert.ok(providers.tts);
  const audio = await providers.tts.synthesize("Hello there", new AbortController().signal);
  assert.deepEqual([...audio.bytes], [0x49, 0x44, 0x33]);
  assert.equal(audio.mimeType, "audio/mpeg");
  assert.deepEqual(requestBody, { model: "tts-model", input: "Hello there", voice: "voice-a", response_format: "mp3" });
});

test("OpenAI-compatible voice provider rejects insecure remote URLs and URL credentials", () => {
  assert.throws(() => createOpenAICompatibleVoiceProviders({
    baseUrl: "http://voice.example.test/v1",
    apiKey: "secret",
    sttModel: "stt",
  }), /HTTPS/);
  assert.throws(() => createOpenAICompatibleVoiceProviders({
    baseUrl: "https://user:pass@voice.example.test/v1",
    apiKey: "secret",
    sttModel: "stt",
  }), /credentials/);
  assert.throws(() => createOpenAICompatibleVoiceProviders({
    baseUrl: "https://voice.example.test/v1?token=secret",
    apiKey: "secret",
    sttModel: "stt",
  }), /query/);
});

test("OpenAI-compatible voice provider rejects malformed responses and oversized payloads", async () => {
  const malformed = createOpenAICompatibleVoiceProviders({
    baseUrl: "https://voice.example.test/v1",
    apiKey: "secret",
    sttModel: "stt",
    fetchImpl: async () => mockResponse(JSON.stringify({ nope: "not transcript" })),
  });
  await assert.rejects(
    malformed.stt.transcribe({ bytes: new Uint8Array([1]), mimeType: "audio/wav", durationMs: 1000 }, new AbortController().signal),
    /did not contain text/,
  );

  const oversized = createOpenAICompatibleVoiceProviders({
    baseUrl: "https://voice.example.test/v1",
    apiKey: "secret",
    sttModel: "stt",
    maxResponseBytes: 8,
    fetchImpl: async () => mockResponse(JSON.stringify({ text: "too large" })),
  });
  await assert.rejects(
    oversized.stt.transcribe({ bytes: new Uint8Array([1]), mimeType: "audio/wav", durationMs: 1000 }, new AbortController().signal),
    /exceeds configured byte limit/,
  );
});

test("OpenAI-compatible voice provider forwards cancellation and rejects non-audio TTS", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const providers = createOpenAICompatibleVoiceProviders({
    baseUrl: "https://voice.example.test/v1",
    apiKey: "secret",
    sttModel: "stt",
    ttsModel: "tts",
    fetchImpl: async () => mockResponse("unexpected", 200, "application/json"),
  });
  await assert.rejects(
    providers.stt.transcribe({ bytes: new Uint8Array([1]), mimeType: "audio/wav", durationMs: 1000 }, controller.signal),
    /cancelled/,
  );
  await assert.rejects(providers.tts!.synthesize("hello", new AbortController().signal), /non-audio content type/);
});


test("OpenAI-compatible voice provider stops streaming once response exceeds limit", async () => {
  const providers = createOpenAICompatibleVoiceProviders({
    baseUrl: "https://voice.example.test/v1",
    apiKey: "secret",
    sttModel: "stt",
    maxResponseBytes: 8,
    fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(9));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(
    providers.stt.transcribe({ bytes: new Uint8Array([1]), mimeType: "audio/wav", durationMs: 1000 }, new AbortController().signal),
    /exceeds configured byte limit/,
  );
});

test("OpenAI-compatible voice provider does not expose provider error response bodies", async () => {
  const providers = createOpenAICompatibleVoiceProviders({
    baseUrl: "https://voice.example.test/v1",
    apiKey: "secret",
    sttModel: "stt",
    fetchImpl: async () => mockResponse("sensitive-provider-error-body", 500),
  });
  await assert.rejects(
    providers.stt.transcribe({ bytes: new Uint8Array([1]), mimeType: "audio/wav", durationMs: 1000 }, new AbortController().signal),
    (error: unknown) => error instanceof Error
      && /HTTP 500/.test(error.message)
      && !error.message.includes("sensitive-provider-error-body"),
  );
});
