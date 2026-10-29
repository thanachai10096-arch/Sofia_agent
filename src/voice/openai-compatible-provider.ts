import type {
  SpeechToTextProvider,
  TextToSpeechProvider,
  VoiceAudioInput,
  VoiceAudioOutput,
} from "./workflow.js";

export interface OpenAICompatibleVoiceConfig {
  /** Trusted provider base URL, e.g. https://api.example.com/v1. */
  baseUrl: string;
  apiKey: string;
  sttModel: string;
  ttsModel?: string;
  ttsVoice?: string;
  /** Optional fetch injection for deterministic tests and host networking policy. */
  fetchImpl?: typeof fetch;
  /** Maximum provider response body size. Defaults to 10 MiB. */
  maxResponseBytes?: number;
}

function validateModel(value: string, name: string): string {
  const model = value.trim();
  if (!model || model.length > 200 || /[\r\n\0]/.test(model)) {
    throw new Error(name + " must be a non-empty model identifier.");
  }
  return model;
}

function validateBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Voice provider baseUrl must be an absolute URL.");
  }
  const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHost)) {
    throw new Error("Voice provider baseUrl must use HTTPS (HTTP is allowed only for loopback development).");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Voice provider baseUrl must not contain credentials, query, or fragment.");
  }
  if (url.pathname.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Voice provider baseUrl must not contain dot path segments.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

function endpoint(base: URL, suffix: string): string {
  return new URL(base.toString().replace(/\/+$/, "") + "/" + suffix, base.origin).toString();
}

function assertResponseLimit(value: number | undefined): number {
  const limit = value ?? 10 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 * 1024 * 1024) {
    throw new Error("maxResponseBytes must be an integer between 1 and 104857600.");
  }
  return limit;
}

async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Voice provider response exceeds configured byte limit.");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Voice provider response exceeds configured byte limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function providerError(response: Response): Promise<Error> {
  // Do not include arbitrary provider response bodies: they may contain secrets or personal data.
  return new Error("Voice provider request failed with HTTP " + response.status + ".");
}

/**
 * Adapter for providers that implement OpenAI-compatible /audio/transcriptions
 * and /audio/speech endpoints. It is opt-in and is not registered automatically.
 * Credentials are sent only to the explicitly configured HTTPS provider origin.
 */
export function createOpenAICompatibleVoiceProviders(config: OpenAICompatibleVoiceConfig): {
  stt: SpeechToTextProvider;
  tts?: TextToSpeechProvider;
} {
  if (!config || typeof config.apiKey !== "string" || !config.apiKey.trim()) {
    throw new Error("Voice provider apiKey is required.");
  }
  if (/[\r\n\0]/.test(config.apiKey)) throw new Error("Voice provider apiKey contains invalid control characters.");
  const base = validateBaseUrl(config.baseUrl);
  const sttModel = validateModel(config.sttModel, "sttModel");
  const ttsModel = config.ttsModel ? validateModel(config.ttsModel, "ttsModel") : undefined;
  const ttsVoice = config.ttsVoice?.trim() || "alloy";
  if (ttsVoice.length > 100 || /[\r\n\0]/.test(ttsVoice)) throw new Error("ttsVoice is invalid.");
  const fetcher = config.fetchImpl ?? fetch;
  const maxResponseBytes = assertResponseLimit(config.maxResponseBytes);

  const stt: SpeechToTextProvider = {
    async transcribe(input: VoiceAudioInput, signal: AbortSignal): Promise<string> {
      signal.throwIfAborted();
      const form = new FormData();
      form.set("model", sttModel);
      form.set("response_format", "json");
      form.set("file", new Blob([input.bytes], { type: input.mimeType }), "audio-input");
      const response = await fetcher(endpoint(base, "audio/transcriptions"), {
        method: "POST",
        headers: { authorization: "Bearer " + config.apiKey },
        body: form,
        signal,
        redirect: "error",
      });
      if (!response.ok) throw await providerError(response);
      const bytes = await readLimited(response, maxResponseBytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new Error("Voice provider transcription response was not valid JSON.");
      }
      if (!parsed || typeof parsed !== "object" || typeof (parsed as { text?: unknown }).text !== "string") {
        throw new Error("Voice provider transcription response did not contain text.");
      }
      return (parsed as { text: string }).text;
    },
  };

  if (!ttsModel) return { stt };

  const tts: TextToSpeechProvider = {
    async synthesize(text: string, signal: AbortSignal): Promise<VoiceAudioOutput> {
      signal.throwIfAborted();
      if (typeof text !== "string" || !text.trim() || text.length > 20_000) {
        throw new Error("Voice synthesis text must contain 1-20000 characters.");
      }
      const response = await fetcher(endpoint(base, "audio/speech"), {
        method: "POST",
        headers: {
          authorization: "Bearer " + config.apiKey,
          "content-type": "application/json",
          accept: "audio/*",
        },
        body: JSON.stringify({
          model: ttsModel,
          input: text,
          voice: ttsVoice,
          response_format: "mp3",
        }),
        signal,
        redirect: "error",
      });
      if (!response.ok) throw await providerError(response);
      const bytes = await readLimited(response, maxResponseBytes);
      if (bytes.byteLength === 0) throw new Error("Voice provider returned empty synthesized audio.");
      const mimeType = (response.headers.get("content-type") ?? "audio/mpeg").split(";")[0]!.trim().toLowerCase();
      if (!mimeType.startsWith("audio/")) throw new Error("Voice provider returned a non-audio content type.");
      return { bytes, mimeType };
    },
  };

  return { stt, tts };
}
