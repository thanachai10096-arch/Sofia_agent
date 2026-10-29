import type { VoiceAudioInput, VoiceAudioOutput, VoiceTurnResult, VoiceWorkflow } from "./workflow.js";

/**
 * Channels normalize authenticated platform events into this contract. This
 * module intentionally does not authenticate webhooks, fetch remote media, or
 * implement platform-specific transports.
 */
export type VoiceChannel =
  | "api" | "sdk" | "cli" | "web" | "desktop" | "mobile"
  | "telegram" | "discord-text" | "discord-voice" | "slack"
  | "whatsapp" | "signal" | "matrix";

const VOICE_CHANNELS: ReadonlySet<string> = new Set([
  "api", "sdk", "cli", "web", "desktop", "mobile",
  "telegram", "discord-text", "discord-voice", "slack",
  "whatsapp", "signal", "matrix",
]);

export interface VerifiedVoiceEvent {
  channel: VoiceChannel;
  /** Stable platform event/message ID, not user-supplied text. */
  eventId: string;
  /** Immutable identity established by the channel adapter. */
  senderId: string;
  /** Stable conversation/channel/session ID established by the adapter. */
  conversationId: string;
  audio: VoiceAudioInput;
  replyMode?: "text" | "audio" | "both";
}

export interface VoiceEventDeduplicator {
  /** Atomically claim an event key. Must be durable for multi-worker deployments. */
  claim(key: string): boolean | Promise<boolean>;
}

export interface VoiceChannelAccessPolicy {
  isAllowed(input: {
    channel: VoiceChannel;
    senderId: string;
    conversationId: string;
  }): boolean | Promise<boolean>;
}

export interface VoiceChannelDelivery {
  deliver(input: {
    channel: VoiceChannel;
    senderId: string;
    conversationId: string;
    eventId: string;
    text: string;
    audio?: VoiceAudioOutput;
  }): Promise<void>;
}

export type VoiceChannelResult =
  | { status: "forbidden" | "duplicate" }
  | { status: "accepted"; transcript: string; replyText: string; audioDelivered: boolean };

export interface VoiceChannelHandlerOptions {
  workflow: VoiceWorkflow;
  accessPolicy: VoiceChannelAccessPolicy;
  deduplicator: VoiceEventDeduplicator;
  delivery: VoiceChannelDelivery;
}

/**
 * Creates a channel-neutral voice handler. Platform adapters must verify
 * signatures/webhook secrets, enforce payload limits, safely fetch media, and
 * derive identity fields before calling this handler. Transcripts are never
 * logged here and are passed only to the configured VoiceWorkflow.
 *
 * A claimed event remains claimed if downstream processing fails. This
 * deliberate at-most-once default prevents accidental duplicate agent actions
 * when a provider accepted a task but the channel reply failed. Operators that
 * need retries should use a durable run/idempotency contract, not blindly
 * release claims after an ambiguous failure.
 */
export function createVoiceChannelHandler(options: VoiceChannelHandlerOptions) {
  return async function handle(event: VerifiedVoiceEvent, signal: AbortSignal): Promise<VoiceChannelResult> {
    signal.throwIfAborted();
    if (!event || typeof event !== "object" || !VOICE_CHANNELS.has(event.channel)) {
      throw new Error("Invalid voice event channel");
    }
    for (const [name, value] of [
      ["eventId", event.eventId],
      ["senderId", event.senderId],
      ["conversationId", event.conversationId],
    ] as const) {
      if (typeof value !== "string" || !value.trim() || value.length > 512) {
        throw new Error("Invalid voice event " + name);
      }
    }

    const allowed = await options.accessPolicy.isAllowed({
      channel: event.channel,
      senderId: event.senderId,
      conversationId: event.conversationId,
    });
    if (!allowed) return { status: "forbidden" };

    // Length-prefixing avoids delimiter collisions in provider-controlled IDs.
    const key = [event.channel, event.conversationId, event.eventId]
      .map((part) => `${part.length}:${part}`).join("|");
    if (!(await options.deduplicator.claim(key))) return { status: "duplicate" };

    const result: VoiceTurnResult = await options.workflow.processAudio(event.audio, signal);
    const replyMode = event.replyMode ?? "both";
    const audio = replyMode === "text" ? undefined : result.audioReply;
    const text = replyMode === "audio" && audio ? "" : result.replyText;

    await options.delivery.deliver({
      channel: event.channel,
      senderId: event.senderId,
      conversationId: event.conversationId,
      eventId: event.eventId,
      text,
      ...(audio ? { audio } : {}),
    });

    return {
      status: "accepted",
      transcript: result.transcript,
      replyText: result.replyText,
      audioDelivered: Boolean(audio),
    };
  };
}
