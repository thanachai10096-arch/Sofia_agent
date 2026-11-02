export interface VoicePreRollFrame {
  /** Audio payload for one frame; copied on insertion and retrieval. */
  bytes: Uint8Array;
  /** Duration represented by this frame. */
  durationMs: number;
}

export interface VoicePreRollOptions {
  maxDurationMs?: number;
  maxBytes?: number;
}

/**
 * Bounded in-memory ring buffer for audio immediately preceding VAD start.
 * Oldest frames are evicted first. It never persists audio or joins frames.
 */
export function createVoicePreRollBuffer(options: VoicePreRollOptions = {}) {
  const maxDurationMs = options.maxDurationMs ?? 300;
  const maxBytes = options.maxBytes ?? 512 * 1024;
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 5_000) {
    throw new Error("maxDurationMs must be an integer between 1 and 5000");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024) {
    throw new Error("maxBytes must be an integer between 1 and 4194304");
  }

  const frames: VoicePreRollFrame[] = [];
  let totalDurationMs = 0;
  let totalBytes = 0;

  const clear = () => {
    frames.length = 0;
    totalDurationMs = 0;
    totalBytes = 0;
  };

  return {
    push(frame: VoicePreRollFrame): void {
      if (!frame || !(frame.bytes instanceof Uint8Array) || frame.bytes.byteLength === 0) {
        throw new Error("Pre-roll frame must contain non-empty audio bytes");
      }
      if (!Number.isSafeInteger(frame.durationMs) || frame.durationMs < 1 || frame.durationMs > maxDurationMs) {
        throw new Error("Pre-roll frame duration is invalid or exceeds the configured window");
      }
      if (frame.bytes.byteLength > maxBytes) throw new Error("Pre-roll frame exceeds the configured byte limit");
      const copy = { bytes: frame.bytes.slice(), durationMs: frame.durationMs };
      frames.push(copy);
      totalDurationMs += copy.durationMs;
      totalBytes += copy.bytes.byteLength;
      while (frames.length && (totalDurationMs > maxDurationMs || totalBytes > maxBytes)) {
        const removed = frames.shift()!;
        totalDurationMs -= removed.durationMs;
        totalBytes -= removed.bytes.byteLength;
      }
    },

    snapshot(): { frames: VoicePreRollFrame[]; durationMs: number; bytes: number } {
      return {
        frames: frames.map((frame) => ({ bytes: frame.bytes.slice(), durationMs: frame.durationMs })),
        durationMs: totalDurationMs,
        bytes: totalBytes,
      };
    },

    take(): VoicePreRollFrame[] {
      const result = frames.map((frame) => ({ bytes: frame.bytes.slice(), durationMs: frame.durationMs }));
      clear();
      return result;
    },

    clear,
  };
}
