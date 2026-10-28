import type { MessagingAdapter, InboundMessage, DeliveryReceipt, OutboundMessage } from "./types.js";
import { splitMessage } from "./format.js";

/** A message emitted only after Slack request signature/timestamp validation and event de-duplication. */
export interface VerifiedSlackMessage {
  signatureVerified: true;
  eventId: string;
  messageId: string;
  channelId: string;
  userId: string;
  text: string;
  createdAt: number;
  threadTs?: string;
  botId?: string;
  subtype?: string;
}
export interface SlackTransport {
  /** Transport must verify X-Slack-Signature + X-Slack-Request-Timestamp against the raw body. */
  start(signal: AbortSignal, onMessage: (message: VerifiedSlackMessage) => Promise<void>): Promise<void>;
  postMessage(channelId: string, text: string, threadTs?: string): Promise<{ messageId: string }>;
  stop(): Promise<void>;
}

/**
 * Slack adapter for the shared MessagingGateway.
 * Provider authentication belongs to the transport; unverified events are rejected here too.
 */
export function createSlackAdapter(transport: SlackTransport): MessagingAdapter {
  let running = false;
  return {
    platform: "slack",
    async start(signal, onMessage) {
      if (running) return;
      running = true;
      await transport.start(signal, async (event) => {
        if (event.signatureVerified !== true || !event.eventId || !event.messageId ||
            !event.channelId || !event.userId || event.botId || event.subtype === "bot_message") return;
        await onMessage({
          platform: "slack",
          messageId: event.eventId,
          identity: {
            platform: "slack",
            userId: event.userId,
            channelId: event.channelId,
            conversationId: event.channelId,
          },
          text: typeof event.text === "string" ? event.text : "",
          attachments: [],
          receivedAt: event.createdAt,
        } satisfies InboundMessage);
      });
    },
    async send(message: OutboundMessage): Promise<DeliveryReceipt> {
      try {
        let lastId: string | undefined;
        for (const chunk of splitMessage(message.text, 39_000)) {
          const sent = await transport.postMessage(
            message.conversationId,
            chunk,
            message.replyToMessageId ?? undefined,
          );
          lastId = sent.messageId;
        }
        return { state: "sent", ...(lastId ? { providerMessageId: lastId } : {}) };
      } catch {
        return { state: "failed", errorCode: "slack_delivery_failed" };
      }
    },
    async stop() {
      running = false;
      await transport.stop();
    },
  };
}
