export type VoiceActivityEndReason = "silence" | "max-duration";

export interface VoiceActivityOptions {
  /** Duration represented by each detector probability sample. */
  frameDurationMs?: number;
  /** Probability required to begin a speech candidate (0..1). */
  startThreshold?: number;
  /** Lower hysteresis threshold while speech is active (0..startThreshold). */
  stopThreshold?: number;
  /** Continuous candidate speech required before emitting started. */
  minSpeechMs?: number;
  /** Continuous non-speech required to end an active utterance. */
  endSilenceMs?: number;
  /** Hard upper bound for one utterance. */
  maxUtteranceMs?: number;
}

export type VoiceActivityEvent =
  | { type: "started"; atMs: number }
  | { type: "ended"; atMs: number; durationMs: number; reason: VoiceActivityEndReason };

const DEFAULTS = {
  frameDurationMs: 20,
  startThreshold: 0.65,
  stopThreshold: 0.4,
  minSpeechMs: 120,
  endSilenceMs: 500,
  maxUtteranceMs: 30_000,
} as const;

function positiveInteger(value: number, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(name + " must be an integer between 1 and " + max);
  }
  return value;
}

/**
 * Provider-neutral VAD hysteresis and utterance boundary state machine.
 * Feed one speech probability per fixed-duration frame from a trusted host VAD.
 * This class does not inspect raw audio, retain samples, or call an agent.
 */
export function createVoiceActivityDetector(options: VoiceActivityOptions = {}) {
  const frameDurationMs = positiveInteger(options.frameDurationMs ?? DEFAULTS.frameDurationMs, "frameDurationMs", 1_000);
  const minSpeechMs = positiveInteger(options.minSpeechMs ?? DEFAULTS.minSpeechMs, "minSpeechMs", 10_000);
  const endSilenceMs = positiveInteger(options.endSilenceMs ?? DEFAULTS.endSilenceMs, "endSilenceMs", 30_000);
  const maxUtteranceMs = positiveInteger(options.maxUtteranceMs ?? DEFAULTS.maxUtteranceMs, "maxUtteranceMs", 600_000);
  const startThreshold = options.startThreshold ?? DEFAULTS.startThreshold;
  const stopThreshold = options.stopThreshold ?? DEFAULTS.stopThreshold;
  if (!Number.isFinite(startThreshold) || startThreshold < 0 || startThreshold > 1) {
    throw new Error("startThreshold must be between 0 and 1");
  }
  if (!Number.isFinite(stopThreshold) || stopThreshold < 0 || stopThreshold > startThreshold) {
    throw new Error("stopThreshold must be between 0 and startThreshold");
  }
  if (minSpeechMs > maxUtteranceMs) throw new Error("minSpeechMs cannot exceed maxUtteranceMs");

  let elapsedMs = 0;
  let candidateMs = 0;
  let active = false;
  let utteranceStartMs = 0;
  let silenceMs = 0;

  return {
    push(probability: number): VoiceActivityEvent[] {
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new Error("Voice activity probability must be between 0 and 1");
      }
      const frameStartMs = elapsedMs;
      elapsedMs += frameDurationMs;
      const events: VoiceActivityEvent[] = [];

      if (!active) {
        if (probability >= startThreshold) candidateMs += frameDurationMs;
        else candidateMs = 0;

        if (candidateMs >= minSpeechMs) {
          active = true;
          utteranceStartMs = elapsedMs - candidateMs;
          silenceMs = 0;
          events.push({ type: "started", atMs: utteranceStartMs });
        }
        return events;
      }

      if (probability >= stopThreshold) silenceMs = 0;
      else silenceMs += frameDurationMs;

      const durationMs = elapsedMs - utteranceStartMs;
      if (durationMs >= maxUtteranceMs) {
        events.push({ type: "ended", atMs: elapsedMs, durationMs, reason: "max-duration" });
        active = false;
        candidateMs = 0;
        silenceMs = 0;
      } else if (silenceMs >= endSilenceMs) {
        events.push({ type: "ended", atMs: frameStartMs + frameDurationMs, durationMs: durationMs - silenceMs, reason: "silence" });
        active = false;
        candidateMs = 0;
        silenceMs = 0;
      }
      return events;
    },

    reset(): void {
      elapsedMs = 0;
      candidateMs = 0;
      active = false;
      utteranceStartMs = 0;
      silenceMs = 0;
    },

    snapshot(): { elapsedMs: number; active: boolean; candidateMs: number; silenceMs: number } {
      return { elapsedMs, active, candidateMs, silenceMs };
    },
  };
}
