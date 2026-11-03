import type { VoiceAudioInput, VoiceTurnResult, VoiceWorkflow } from "./workflow.js";

export type VoiceSessionState = "idle" | "processing" | "interrupting" | "closed";

export interface VoiceSessionSnapshot {
  state: VoiceSessionState;
  turnId: number;
}

export interface VoiceSessionOptions {
  /** Observer only; callback failures never affect voice processing. */
  onStateChange?: (snapshot: VoiceSessionSnapshot) => void;
}

export interface VoiceSession {
  snapshot(): VoiceSessionSnapshot;
  processTurn(input: VoiceAudioInput, signal?: AbortSignal): Promise<VoiceTurnResult>;
  /** Requests cancellation of the active turn. The session stays busy until it settles. */
  interrupt(reason?: string): boolean;
  /** Permanently closes the session and cancels any active turn. */
  close(reason?: string): void;
}

function abortError(reason: string): Error {
  return new Error(reason);
}

/**
 * Owns the lifecycle of one conversational voice session while reusing the
 * existing VoiceWorkflow. This is turn orchestration, not a realtime media
 * transport: streaming capture/playback and VAD remain channel responsibilities.
 */
export function createVoiceSession(
  workflow: VoiceWorkflow,
  options: VoiceSessionOptions = {},
): VoiceSession {
  let state: VoiceSessionState = "idle";
  let turnId = 0;
  let activeController: AbortController | undefined;
  let externalAbort: (() => void) | undefined;

  const snapshot = (): VoiceSessionSnapshot => ({ state, turnId });
  const publish = () => {
    try { options.onStateChange?.(snapshot()); } catch { /* observers cannot break the session */ }
  };

  return {
    snapshot,

    async processTurn(input, signal) {
      if (state === "closed") throw abortError("Voice session is closed");
      if (state !== "idle") throw new Error("Voice session already has an active turn");
      signal?.throwIfAborted();

      const controller = new AbortController();
      turnId++;
      activeController = controller;
      state = "processing";

      if (signal) {
        externalAbort = () => controller.abort(signal.reason ?? abortError("Voice turn aborted"));
        signal.addEventListener("abort", externalAbort, { once: true });
        if (signal.aborted) externalAbort();
      }
      publish();

      try {
        return await workflow.processAudio(input, controller.signal);
      } finally {
        if (signal && externalAbort) signal.removeEventListener("abort", externalAbort);
        externalAbort = undefined;
        if (activeController === controller) activeController = undefined;
        if (snapshot().state !== "closed") {
          state = "idle";
          publish();
        }
      }
    },

    interrupt(reason = "Voice turn interrupted") {
      if (state !== "processing" || !activeController) return false;
      state = "interrupting";
      publish();
      activeController.abort(abortError(reason));
      return true;
    },

    close(reason = "Voice session closed") {
      if (state === "closed") return;
      state = "closed";
      activeController?.abort(abortError(reason));
      publish();
    },
  };
}
