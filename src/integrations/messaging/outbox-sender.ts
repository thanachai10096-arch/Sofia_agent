import type { OutboxDeliveryContext, OutboxSender } from "../../brain/outbox-dispatcher.js";
import type { MessagingAdapter, OutboundMessage } from "./types.js";

const SUPPORTED_EVENTS = new Set(["job.completed", "job.failed", "job.cancelled"]);
const MAX_NOTIFICATION_TEXT = 16_000;

function parseDestination(value: string): { platform: "telegram" | "discord"; conversationId: string } {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("Unsupported outbox messaging destination.");
  }
  const platform = value.slice(0, separator);
  const conversationId = value.slice(separator + 1);
  const validId = platform === "discord"
    ? /^\d{1,24}$/.test(conversationId)
    : platform === "telegram"
      ? /^-?\d{1,20}$/.test(conversationId)
      : false;
  if (!validId) throw new Error("Unsupported outbox messaging destination.");
  return { platform: platform as "telegram" | "discord", conversationId };
}

function notificationText(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Outbox notification payload must be an object.");
  }
  const text = (payload as Record<string, unknown>).text;
  if (typeof text !== "string" || !text.trim() || text.length > MAX_NOTIFICATION_TEXT) {
    throw new Error("Outbox notification payload has invalid text.");
  }
  return text;
}

/**
 * Bridges durable job notifications to already-configured messaging adapters.
 * Destinations must be persisted as "telegram:<chatId>" or "discord:<channelId>".
 * The adapter map is an explicit capability allowlist; no arbitrary URL or
 * provider credential can be supplied by an outbox payload.
 */
export function createMessagingOutboxSender(
  adapters: readonly MessagingAdapter[],
): OutboxSender {
  const byPlatform = new Map<string, MessagingAdapter>();
  for (const adapter of adapters) {
    if (adapter.platform !== "telegram" && adapter.platform !== "discord") continue;
    if (byPlatform.has(adapter.platform)) {
      throw new Error(`Duplicate messaging adapter: ${adapter.platform}`);
    }
    byPlatform.set(adapter.platform, adapter);
  }

  return async (delivery: OutboxDeliveryContext): Promise<void> => {
    if (delivery.signal?.aborted) throw delivery.signal.reason ?? new Error("Delivery aborted.");
    if (!SUPPORTED_EVENTS.has(delivery.eventType)) {
      throw new Error("Unsupported outbox notification event.");
    }
    const { platform, conversationId } = parseDestination(delivery.destination);
    const adapter = byPlatform.get(platform);
    if (!adapter) throw new Error(`No enabled messaging adapter for ${platform}.`);

    const message: OutboundMessage = {
      conversationId,
      text: notificationText(delivery.payload),
      deliveryId: delivery.messageId,
    };
    const receipt = await adapter.send(message);
    if (receipt.state !== "sent") {
      // "unknown" is intentionally retried: the receiver may have accepted the
      // message before the transport lost its acknowledgement. Delivery is
      // therefore at-least-once and can produce duplicates.
      throw new Error(`${platform} notification delivery was ${receipt.state}.`);
    }
  };
}
