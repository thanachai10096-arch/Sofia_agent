export interface VoiceAudioInput {
  bytes: Uint8Array;
  mimeType: string;
  durationMs: number;
}
export interface VoiceAudioOutput {
  bytes: Uint8Array;
  mimeType: string;
}
export interface SpeechToTextProvider {
  transcribe(input: VoiceAudioInput, signal: AbortSignal): Promise<string>;
}
export interface TextToSpeechProvider {
  synthesize(text: string, signal: AbortSignal): Promise<VoiceAudioOutput>;
}
export interface VoiceAgentReply {
  text: string;
  value?: unknown;
}
export interface VoiceTurnResult {
  transcript: string;
  replyText: string;
  agentValue?: unknown;
  audioReply?: VoiceAudioOutput;
}
export interface VoiceWorkflowOptions {
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxDurationMs?: number;
  maxTranscriptChars?: number;
  stageTimeoutMs?: number;
  allowedMimeTypes?: readonly string[];
}

const DEFAULT_MIME_TYPES = ["audio/wav", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/webm", "audio/flac", "audio/aac"];
function validateLimit(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(name + " must be an integer between " + min + " and " + max);
  return value;
}
function withTimeout<T>(parent: AbortSignal, timeoutMs: number, label: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  parent.throwIfAborted();
  const controller = new AbortController();
  const abortParent = () => controller.abort(parent.reason);
  parent.addEventListener("abort", abortParent, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Voice " + label + " timed out")), timeoutMs);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error("Voice operation aborted"));
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([Promise.resolve().then(() => operation(controller.signal)), aborted]).finally(() => {
    clearTimeout(timer);
    parent.removeEventListener("abort", abortParent);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  });
}

/**
 * Optional voice pipeline. Provider implementations are supplied by the host;
 * transcribed text still goes through the host's ordinary Sofia agent/policy path.
 * Audio is processed in memory and is not persisted by this class.
 */
export class VoiceWorkflow {
  private readonly maxInputBytes: number;
  private readonly maxOutputBytes: number;
  private readonly maxDurationMs: number;
  private readonly maxTranscriptChars: number;
  private readonly stageTimeoutMs: number;
  private readonly allowedMimeTypes: Set<string>;

  constructor(
    private readonly speechToText: SpeechToTextProvider,
    private readonly runAgent: (transcript: string, signal: AbortSignal) => Promise<VoiceAgentReply>,
    private readonly textToSpeech?: TextToSpeechProvider,
    options: VoiceWorkflowOptions = {},
  ) {
    this.maxInputBytes = validateLimit(options.maxInputBytes ?? 10 * 1024 * 1024, "maxInputBytes", 1, 100 * 1024 * 1024);
    this.maxOutputBytes = validateLimit(options.maxOutputBytes ?? 10 * 1024 * 1024, "maxOutputBytes", 1, 100 * 1024 * 1024);
    this.maxDurationMs = validateLimit(options.maxDurationMs ?? 120_000, "maxDurationMs", 1_000, 600_000);
    this.maxTranscriptChars = validateLimit(options.maxTranscriptChars ?? 20_000, "maxTranscriptChars", 100, 100_000);
    this.stageTimeoutMs = validateLimit(options.stageTimeoutMs ?? 30_000, "stageTimeoutMs", 100, 300_000);
    this.allowedMimeTypes = new Set((options.allowedMimeTypes ?? DEFAULT_MIME_TYPES).map((item) => item.toLowerCase().split(";")[0]!.trim()));
    if (this.allowedMimeTypes.size === 0 || [...this.allowedMimeTypes].some((item) => !item.startsWith("audio/"))) throw new Error("Allowed MIME types must be audio types");
  }

  async processAudio(input: VoiceAudioInput, signal: AbortSignal): Promise<VoiceTurnResult> {
    signal.throwIfAborted();
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) throw new Error("Voice input audio must be a non-empty byte array");
    if (input.bytes.byteLength > this.maxInputBytes) throw new Error("Voice input exceeds configured byte limit");
    if (!Number.isFinite(input.durationMs) || input.durationMs <= 0 || input.durationMs > this.maxDurationMs) {
      throw new Error("Voice input duration is invalid or exceeds configured limit");
    }
    const mimeType = input.mimeType.toLowerCase().split(";")[0]!.trim();
    if (!this.allowedMimeTypes.has(mimeType)) throw new Error("Voice input MIME type is not allowed");
    const audio: VoiceAudioInput = { bytes: input.bytes.slice(), mimeType, durationMs: input.durationMs };

    const rawTranscript = await withTimeout(signal, this.stageTimeoutMs, "transcription", (stageSignal) =>
      this.speechToText.transcribe(audio, stageSignal));
    if (typeof rawTranscript !== "string") throw new Error("Speech-to-text provider returned a non-text transcript");
    const transcript = rawTranscript.trim();
    if (!transcript) throw new Error("Speech-to-text provider returned an empty transcript");
    if (transcript.length > this.maxTranscriptChars) throw new Error("Voice transcript exceeds configured character limit");

    const reply = await withTimeout(signal, this.stageTimeoutMs, "agent processing", (stageSignal) =>
      this.runAgent(transcript, stageSignal));
    if (!reply || typeof reply.text !== "string" || !reply.text.trim()) throw new Error("Sofia agent returned an empty voice reply");
    const result: VoiceTurnResult = {
      transcript,
      replyText: reply.text.slice(0, this.maxTranscriptChars),
      ...(reply.value === undefined ? {} : { agentValue: reply.value }),
    };

    if (this.textToSpeech) {
      const audioReply = await withTimeout(signal, this.stageTimeoutMs, "speech synthesis", (stageSignal) =>
        this.textToSpeech!.synthesize(result.replyText, stageSignal));
      if (!(audioReply.bytes instanceof Uint8Array) || audioReply.bytes.byteLength === 0) throw new Error("Text-to-speech provider returned empty audio");
      if (audioReply.bytes.byteLength > this.maxOutputBytes) throw new Error("Voice output exceeds configured byte limit");
      const outputMime = audioReply.mimeType.toLowerCase().split(";")[0]!.trim();
      if (!outputMime.startsWith("audio/")) throw new Error("Text-to-speech provider returned an invalid audio MIME type");
      result.audioReply = { bytes: audioReply.bytes.slice(), mimeType: outputMime };
    }
    return result;
  }
}


export interface VoiceProviderSelection {
  enabled: boolean;
  sttProviderId?: string;
  ttsProviderId?: string;
}

export interface VoiceProviderRegistry {
  registerStt(id: string, provider: SpeechToTextProvider): void;
  registerTts(id: string, provider: TextToSpeechProvider): void;
  resolve(selection: VoiceProviderSelection): {
    enabled: boolean;
    stt?: SpeechToTextProvider;
    tts?: TextToSpeechProvider;
    sttProviderId?: string;
    ttsProviderId?: string;
  };
  list(): { stt: string[]; tts: string[] };
}

function validateVoiceProviderId(id: string): string {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
    throw new Error("Voice provider ID must be 1-64 characters using letters, numbers, dot, underscore, or hyphen.");
  }
  return id;
}

/** Explicit STT/TTS routing independent of the main LLM route. */
export function createVoiceProviderRegistry(): VoiceProviderRegistry {
  const stt = new Map<string, SpeechToTextProvider>();
  const tts = new Map<string, TextToSpeechProvider>();
  return {
    registerStt(id, provider) {
      const key = validateVoiceProviderId(id);
      if (!provider || typeof provider.transcribe !== "function") throw new Error("STT provider must implement transcribe().");
      if (stt.has(key)) throw new Error("STT provider is already registered: " + key);
      stt.set(key, provider);
    },
    registerTts(id, provider) {
      const key = validateVoiceProviderId(id);
      if (!provider || typeof provider.synthesize !== "function") throw new Error("TTS provider must implement synthesize().");
      if (tts.has(key)) throw new Error("TTS provider is already registered: " + key);
      tts.set(key, provider);
    },
    resolve(selection) {
      if (!selection || selection.enabled !== true) return { enabled: false };
      if (!selection.sttProviderId) throw new Error("Voice is enabled but no STT provider ID is selected.");
      const sttId = validateVoiceProviderId(selection.sttProviderId);
      const sttProvider = stt.get(sttId);
      if (!sttProvider) throw new Error("Selected STT provider is not registered: " + sttId);
      if (selection.ttsProviderId) {
        const ttsId = validateVoiceProviderId(selection.ttsProviderId);
        const ttsProvider = tts.get(ttsId);
        if (!ttsProvider) throw new Error("Selected TTS provider is not registered: " + ttsId);
        return { enabled: true, stt: sttProvider, tts: ttsProvider, sttProviderId: sttId, ttsProviderId: ttsId };
      }
      return { enabled: true, stt: sttProvider, sttProviderId: sttId };
    },
    list() { return { stt: [...stt.keys()].sort(), tts: [...tts.keys()].sort() }; },
  };
}

/** Reads only non-secret routing settings; voice remains disabled by default. */
export function loadVoiceProviderSelectionFromEnv(
  env: Record<string, string | undefined> = process.env,
): VoiceProviderSelection {
  const rawEnabled = env.SOFIA_VOICE_ENABLED?.trim().toLowerCase() ?? "";
  const enabled = ["true", "1", "yes"].includes(rawEnabled);
  if (rawEnabled && !enabled && !["false", "0", "no"].includes(rawEnabled)) {
    throw new Error("SOFIA_VOICE_ENABLED must be true/false, 1/0, or yes/no.");
  }
  if (!enabled) return { enabled: false };
  const sttProviderId = env.SOFIA_VOICE_STT_PROVIDER?.trim();
  const ttsProviderId = env.SOFIA_VOICE_TTS_PROVIDER?.trim();
  if (!sttProviderId) throw new Error("SOFIA_VOICE_ENABLED=true requires SOFIA_VOICE_STT_PROVIDER.");
  return {
    enabled: true,
    sttProviderId: validateVoiceProviderId(sttProviderId),
    ...(ttsProviderId ? { ttsProviderId: validateVoiceProviderId(ttsProviderId) } : {}),
  };
}
