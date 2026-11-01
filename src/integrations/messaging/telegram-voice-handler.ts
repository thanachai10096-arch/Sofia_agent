import type { TelegramVoiceMessage } from "./telegram.js";
import type { TelegramVoiceFile } from "./telegram-voice-media.js";
import type { VoiceWorkflow, VoiceAudioInput, VoiceAudioOutput } from "../../voice/workflow.js";

export interface TelegramVoiceMediaClient {
  downloadVoice(fileId: string, signal: AbortSignal): Promise<TelegramVoiceFile>;
  sendVoice(chatId: string, audio: TelegramVoiceFile, signal: AbortSignal): Promise<void>;
}

/**
 * A trusted decoder/inspector supplied by the host (for example, a sandboxed
 * ffprobe/codec worker). It MUST decode the downloaded bytes and derive the
 * actual container/codec and duration; Telegram metadata and file extensions
 * are hints only and must never be returned as verified facts without parsing.
 */
export interface TelegramAudioInspector {
  inspect(input: { bytes: Uint8Array; declaredMimeType: string; signal: AbortSignal }): Promise<{
    mimeType: string;
    durationMs: number;
  }>;
}

export interface TelegramVoiceDeduplicator {
  claim(key: string): boolean | Promise<boolean>;
}

export interface TelegramVoiceHandlerOptions {
  media: TelegramVoiceMediaClient;
  inspector: TelegramAudioInspector;
  workflow: VoiceWorkflow;
  accessPolicy: {
    isAllowed(input: { platform: "telegram"; senderId: string; conversationId: string }): boolean | Promise<boolean>;
  };
  deduplicator: TelegramVoiceDeduplicator;
  sendText(input: { chatId: string; text: string; replyToMessageId: string }): Promise<void>;
  maxInputBytes?: number;
  maxDurationMs?: number;
  replyMode?: "text" | "audio" | "both";
  onWarning?: (event: "telegram_voice_forbidden" | "telegram_voice_duplicate" | "telegram_voice_failed") => void;
}

function positiveLimit(value: number | undefined, fallback: number, name: string, max: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw new Error(name + " must be an integer between 1 and " + max);
  }
  return limit;
}

/**
 * Creates the Telegram voice callback for createTelegramAdapter's existing
 * poller. Authorization and durable dedupe happen BEFORE media download.
 * No second Telegram polling loop is created.
 */
export function createTelegramVoiceMessageHandler(options: TelegramVoiceHandlerOptions) {
  const maxInputBytes = positiveLimit(options.maxInputBytes, 10 * 1024 * 1024, "maxInputBytes", 50 * 1024 * 1024);
  const maxDurationMs = positiveLimit(options.maxDurationMs, 120_000, "maxDurationMs", 600_000);
  const replyMode = options.replyMode ?? "both";

  return async function handle(message: TelegramVoiceMessage, signal: AbortSignal): Promise<"forbidden" | "duplicate" | "processed"> {
    signal.throwIfAborted();
    const allowed = await options.accessPolicy.isAllowed({
      platform: "telegram",
      senderId: message.userId,
      conversationId: message.conversationId,
    });
    if (!allowed) {
      options.onWarning?.("telegram_voice_forbidden");
      return "forbidden";
    }

    // Provider IDs are length-prefixed to avoid delimiter collisions.
    const key = ["telegram", message.conversationId, message.messageId]
      .map((part) => part.length + ":" + part).join("|");
    if (!(await options.deduplicator.claim(key))) {
      options.onWarning?.("telegram_voice_duplicate");
      return "duplicate";
    }

    try {
      if (message.fileSizeBytes !== undefined &&
          (!Number.isSafeInteger(message.fileSizeBytes) || message.fileSizeBytes < 1 || message.fileSizeBytes > maxInputBytes)) {
        throw new Error("Telegram voice metadata exceeds configured byte limit");
      }
      const downloaded = await options.media.downloadVoice(message.fileId, signal);
      if (downloaded.bytes.byteLength === 0 || downloaded.bytes.byteLength > maxInputBytes) {
        throw new Error("Telegram voice download exceeds configured byte limit");
      }

      // Never trust Telegram's duration or MIME hint. Decode and inspect actual bytes.
      const inspected = await options.inspector.inspect({
        bytes: downloaded.bytes,
        declaredMimeType: message.mimeType,
        signal,
      });
      if (!inspected || typeof inspected.mimeType !== "string" ||
          !/^audio\/[a-z0-9.+-]{1,64}$/i.test(inspected.mimeType) ||
          !Number.isSafeInteger(inspected.durationMs) ||
          inspected.durationMs < 1 || inspected.durationMs > maxDurationMs) {
        throw new Error("Telegram voice media failed audio inspection");
      }
      const audio: VoiceAudioInput = {
        bytes: downloaded.bytes,
        mimeType: inspected.mimeType.toLowerCase(),
        durationMs: inspected.durationMs,
      };
      const result = await options.workflow.processAudio(audio, signal);

      if (replyMode !== "audio" || !result.audioReply) {
        await options.sendText({
          chatId: message.conversationId,
          text: result.replyText,
          replyToMessageId: message.messageId,
        });
      }
      if (replyMode !== "text" && result.audioReply) {
        const output: VoiceAudioOutput = result.audioReply;
        await options.media.sendVoice(message.conversationId, {
          bytes: output.bytes,
          mimeType: output.mimeType,
        }, signal);
      }
      return "processed";
    } catch (error) {
      options.onWarning?.("telegram_voice_failed");
      throw error;
    }
  };
}
