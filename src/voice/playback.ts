import type { VoiceAudioOutput } from "./workflow.js";

export interface VoicePlaybackAdapter {
  /** Play until completion or until the supplied signal is aborted. */
  play(audio: VoiceAudioOutput, signal: AbortSignal): Promise<void>;
  /** Stop any currently audible output and settle only when it is no longer playing. */
  stop(): void | Promise<void>;
}

export interface VoicePlaybackController {
  /** Replaces any previous playback; false means superseded or interrupted. */
  play(audio: VoiceAudioOutput): Promise<boolean>;
  /** Abort current output and wait for the host player to become silent. */
  interrupt(): Promise<void>;
  /** Permanently stop output and reject future play requests. */
  close(): Promise<void>;
  snapshot(): { state: "idle" | "playing" | "closed"; generation: number };
}

/**
 * Host-neutral playback lifecycle for desktop, web, mobile, and voice channels.
 * The host supplies the actual audio device/player; this class owns cancellation,
 * replacement ordering, and stale-playback suppression only.
 */
export function createVoicePlaybackController(adapter: VoicePlaybackAdapter): VoicePlaybackController {
  let state: "idle" | "playing" | "closed" = "idle";
  let generation = 0;
  let active: AbortController | undefined;

  const stopCurrent = async (): Promise<void> => {
    const current = active;
    active = undefined;
    current?.abort(new Error("Voice playback interrupted"));
    await adapter.stop();
    if (state !== "closed" && !active) state = "idle";
  };

  return {
    async play(audio) {
      if (state === "closed") throw new Error("Voice playback controller is closed");
      if (!audio || !(audio.bytes instanceof Uint8Array) || audio.bytes.byteLength === 0 ||
          typeof audio.mimeType !== "string" || !/^audio\/[a-z0-9.+-]{1,64}$/i.test(audio.mimeType)) {
        throw new Error("Voice playback audio is invalid");
      }
      const request = ++generation;
      await stopCurrent();
      if (state === "closed" || request !== generation) return false;

      const controller = new AbortController();
      active = controller;
      state = "playing";
      try {
        await adapter.play({ bytes: audio.bytes.slice(), mimeType: audio.mimeType.toLowerCase() }, controller.signal);
        return !controller.signal.aborted && state !== "closed" && request === generation;
      } finally {
        if (active === controller) {
          active = undefined;
          if (state !== "closed") state = "idle";
        }
      }
    },

    async interrupt() {
      if (state === "closed") return;
      generation++;
      await stopCurrent();
    },

    async close() {
      if (state === "closed") return;
      state = "closed";
      generation++;
      await stopCurrent();
      state = "closed";
    },

    snapshot() {
      return { state, generation };
    },
  };
}
