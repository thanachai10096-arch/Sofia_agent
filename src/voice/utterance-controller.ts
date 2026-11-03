import { createVoiceActivityDetector, type VoiceActivityOptions } from "./activity.js";
import { createVoicePreRollBuffer, type VoicePreRollFrame, type VoicePreRollOptions } from "./pre-roll.js";
import type { VoiceSession } from "./session.js";
import type { VoiceTurnResult } from "./workflow.js";

export interface VoiceUtteranceControllerOptions {
  session: VoiceSession;
  mimeType: string;
  activity?: VoiceActivityOptions;
  preRoll?: VoicePreRollOptions;
  maxUtteranceBytes?: number;
  onSpeechStart?: () => void | Promise<void>;
  onTurnResult?: (result: VoiceTurnResult) => void | Promise<void>;
  onError?: (error: Error) => void;
}

export interface VoiceUtteranceController {
  pushFrame(frame: VoicePreRollFrame, speechProbability: number): void;
  snapshot(): { state: "listening" | "capturing" | "processing" | "closed"; bufferedBytes: number };
  close(reason?: string): void;
}

function bounded(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(name + " must be an integer between 1 and " + maximum);
  }
  return value;
}

/** Connects host VAD probabilities and bounded pre-roll to the existing complete-turn VoiceSession. */
export function createVoiceUtteranceController(options: VoiceUtteranceControllerOptions): VoiceUtteranceController {
  const mimeType = options.mimeType.toLowerCase().split(";")[0]!.trim();
  if (!mimeType.startsWith("audio/")) throw new Error("mimeType must be an audio MIME type");
  const frameDurationMs = options.activity?.frameDurationMs ?? 20;
  const maxUtteranceMs = options.activity?.maxUtteranceMs ?? 30_000;
  const maxBytes = bounded(options.maxUtteranceBytes ?? 10 * 1024 * 1024, "maxUtteranceBytes", 100 * 1024 * 1024);
  const vad = createVoiceActivityDetector(options.activity);
  const preRoll = createVoicePreRollBuffer(options.preRoll);
  let frames: VoicePreRollFrame[] | undefined;
  let bytes = 0;
  let state: "listening" | "capturing" | "processing" | "closed" = "listening";
  let activeTurn: Promise<unknown> | undefined;
  let pending = false;
  let queued: { frames: VoicePreRollFrame[]; durationMs: number } | undefined;
  const isClosed = () => state === "closed";

  const report = (cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error("Voice turn failed");
    try { options.onError?.(error); } catch { /* observer isolation */ }
  };
  const append = (target: VoicePreRollFrame[], frame: VoicePreRollFrame) => {
    if (frame.bytes.byteLength > maxBytes - bytes) throw new Error("Voice utterance exceeds configured byte limit");
    target.push({ bytes: frame.bytes.slice(), durationMs: frame.durationMs });
    bytes += frame.bytes.byteLength;
  };
  const submit = (completed: VoicePreRollFrame[], durationMs: number) => {
    if (pending) {
      if (queued) { report(new Error("Voice utterance queue is full")); return; }
      queued = { frames: completed, durationMs };
      return;
    }
    pending = true;
    state = "processing";
    void (async () => {
      let next: { frames: VoicePreRollFrame[]; durationMs: number } | undefined = { frames: completed, durationMs };
      try {
        while (next && !isClosed()) {
          if (activeTurn) await activeTurn.catch(() => undefined);
          if (isClosed()) break;
          const total = next.frames.reduce((sum, item) => sum + item.bytes.byteLength, 0);
          const audio = new Uint8Array(total);
          let offset = 0;
          for (const item of next.frames) { audio.set(item.bytes, offset); offset += item.bytes.byteLength; }
          const turn = options.session.processTurn({ bytes: audio, mimeType, durationMs: next.durationMs });
          activeTurn = turn;
          try {
            const result = await turn;
            try { await options.onTurnResult?.(result); } catch (error) { report(error); }
          } catch (error) {
            if (!isClosed()) report(error);
          } finally {
            if (activeTurn === turn) activeTurn = undefined;
          }
          next = queued;
          queued = undefined;
        }
      } catch (error) {
        if (!isClosed()) report(error);
      } finally {
        pending = false;
        queued = undefined;
        if (!isClosed()) state = "listening";
      }
    })();
  };

  return {
    pushFrame(frame, probability) {
      if (isClosed()) throw new Error("Voice utterance controller is closed");
      if (!frame || !(frame.bytes instanceof Uint8Array) || frame.bytes.byteLength === 0) throw new Error("Voice frame must contain non-empty audio bytes");
      if (!Number.isSafeInteger(frame.durationMs) || frame.durationMs !== frameDurationMs) throw new Error("Voice frame duration must match the configured VAD frame duration");
      try {
        if (frames) append(frames, frame);
        else preRoll.push(frame);
        for (const event of vad.push(probability)) {
          if (event.type === "started") {
            frames = preRoll.take();
            bytes = frames.reduce((sum, item) => sum + item.bytes.byteLength, 0);
            state = "capturing";
            try { void Promise.resolve(options.onSpeechStart?.()).catch(report); } catch (error) { report(error); }
            options.session.interrupt("Voice activity detected (barge-in)");
          } else {
            const completed = frames ?? [];
            frames = undefined;
            const completedBytes = bytes;
            bytes = 0;
            if (completedBytes > maxBytes) { report(new Error("Voice utterance exceeds configured byte limit")); state = "listening"; continue; }
            submit(completed, Math.min(event.durationMs, maxUtteranceMs));
          }
        }
      } catch (error) {
        frames = undefined; bytes = 0; preRoll.clear(); vad.reset();
        if (!isClosed()) state = "listening";
        throw error;
      }
    },
    snapshot() { return { state, bufferedBytes: bytes + preRoll.snapshot().bytes }; },
    close(reason = "Voice utterance controller closed") {
      if (isClosed()) return;
      state = "closed"; frames = undefined; bytes = 0; queued = undefined; preRoll.clear(); vad.reset();
      options.session.close(reason);
    },
  };
}
