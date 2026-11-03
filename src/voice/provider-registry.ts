import type { SpeechToTextProvider, TextToSpeechProvider } from "./workflow.js";

export interface VoiceProviderSelection {
  /** Voice capability is opt-in. No audio is processed while disabled. */
  enabled: boolean;
  /** Explicit registered provider ID; never inferred from LLM configuration. */
  sttProviderId?: string;
  /** Explicit registered provider ID; omitted means text-only voice replies. */
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

function validateProviderId(id: string): string {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
    throw new Error("Voice provider ID must be 1-64 characters using letters, numbers, dot, underscore, or hyphen.");
  }
  return id;
}

/**
 * Provider registry with explicit selection. Registration does not enable voice
 * and does not read credentials. Hosts should register only implementations
 * that are configured and approved for their deployment.
 */
export function createVoiceProviderRegistry(): VoiceProviderRegistry {
  const stt = new Map<string, SpeechToTextProvider>();
  const tts = new Map<string, TextToSpeechProvider>();

  return {
    registerStt(id, provider) {
      const key = validateProviderId(id);
      if (!provider || typeof provider.transcribe !== "function") throw new Error("STT provider must implement transcribe().");
      if (stt.has(key)) throw new Error("STT provider is already registered: " + key);
      stt.set(key, provider);
    },
    registerTts(id, provider) {
      const key = validateProviderId(id);
      if (!provider || typeof provider.synthesize !== "function") throw new Error("TTS provider must implement synthesize().");
      if (tts.has(key)) throw new Error("TTS provider is already registered: " + key);
      tts.set(key, provider);
    },
    resolve(selection) {
      if (!selection || selection.enabled !== true) return { enabled: false };
      if (!selection.sttProviderId) throw new Error("Voice is enabled but no STT provider ID is selected.");
      const sttId = validateProviderId(selection.sttProviderId);
      const sttProvider = stt.get(sttId);
      if (!sttProvider) throw new Error("Selected STT provider is not registered: " + sttId);
      if (selection.ttsProviderId !== undefined && selection.ttsProviderId !== "") {
        const ttsId = validateProviderId(selection.ttsProviderId);
        const ttsProvider = tts.get(ttsId);
        if (!ttsProvider) throw new Error("Selected TTS provider is not registered: " + ttsId);
        return { enabled: true, stt: sttProvider, tts: ttsProvider, sttProviderId: sttId, ttsProviderId: ttsId };
      }
      return { enabled: true, stt: sttProvider, sttProviderId: sttId };
    },
    list() {
      return { stt: [...stt.keys()].sort(), tts: [...tts.keys()].sort() };
    },
  };
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value.trim() === "") return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  throw new Error(name + " must be true/false, 1/0, or yes/no.");
}

/** Reads only non-secret voice routing settings. It never reads or returns API keys. */
export function loadVoiceProviderSelectionFromEnv(
  env: Record<string, string | undefined> = process.env,
): VoiceProviderSelection {
  const enabled = parseBoolean(env.SOFIA_VOICE_ENABLED, "SOFIA_VOICE_ENABLED");
  const sttProviderId = env.SOFIA_VOICE_STT_PROVIDER?.trim() || undefined;
  const ttsProviderId = env.SOFIA_VOICE_TTS_PROVIDER?.trim() || undefined;
  if (!enabled) return { enabled: false };
  if (!sttProviderId) throw new Error("SOFIA_VOICE_ENABLED=true requires SOFIA_VOICE_STT_PROVIDER.");
  return {
    enabled: true,
    sttProviderId: validateProviderId(sttProviderId),
    ...(ttsProviderId ? { ttsProviderId: validateProviderId(ttsProviderId) } : {}),
  };
}
