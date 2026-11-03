import type { ChatPlatform } from "../chat-adapter.js";
import type { MessagingOutboxRecord } from "./file-outbox.js";

const MAX_RECORD_BYTES = 128_000;
const SAFE_PLATFORM = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_INTEGER = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * Validate persisted spool data before it can influence retry scheduling or reach
 * a provider. Unknown additive fields are retained for forward compatibility.
 * Legacy records may omit retry metadata introduced after the initial spool format.
 */
export function isValidMessagingOutboxRecord(
  value: unknown,
  expectedId: string,
): value is MessagingOutboxRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<MessagingOutboxRecord>;
  if (record.id !== expectedId ||
      typeof record.platform !== "string" || !SAFE_PLATFORM.test(record.platform) ||
      !record.message || typeof record.message !== "object" || Array.isArray(record.message)) return false;

  const message = record.message;
  if (typeof message.conversationId !== "string" || !message.conversationId.trim() ||
      message.conversationId.length > 256 ||
      typeof message.text !== "string" || !message.text.trim() ||
      Buffer.byteLength(message.text, "utf8") > MAX_RECORD_BYTES) return false;

  if (message.replyToMessageId !== undefined &&
      (typeof message.replyToMessageId !== "string" || message.replyToMessageId.length > 256)) return false;
  if (message.interactionId !== undefined &&
      (typeof message.interactionId !== "string" || message.interactionId.length > 512)) return false;
  if (!SAFE_INTEGER(record.createdAt)) return false;

  if (record.attemptCount !== undefined &&
      (!SAFE_INTEGER(record.attemptCount) || record.attemptCount > 8)) return false;
  if (record.lastAttemptAt !== undefined && !SAFE_INTEGER(record.lastAttemptAt)) return false;
  if (record.nextAttemptAt !== undefined && !SAFE_INTEGER(record.nextAttemptAt)) return false;
  if (record.lastErrorCode !== undefined && record.lastErrorCode !== "provider_unavailable") return false;
  if (record.state !== undefined && record.state !== "pending" && record.state !== "dead_letter") return false;

  if (record.attemptHistory !== undefined &&
      (!Array.isArray(record.attemptHistory) || record.attemptHistory.length > 8 ||
       record.attemptHistory.some((entry) => !entry || typeof entry !== "object" ||
         Object.keys(entry).some((key) => !["at", "outcome", "code"].includes(key)) ||
         !SAFE_INTEGER(entry.at) || entry.outcome !== "failed" ||
         entry.code !== "provider_unavailable"))) return false;

  return true;
}

export function isMessagingOutboxPlatform(value: string): value is ChatPlatform {
  return SAFE_PLATFORM.test(value);
}
