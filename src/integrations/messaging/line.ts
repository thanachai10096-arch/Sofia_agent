import type { InboundMessage, MessagingAdapter, OutboundMessage, DeliveryReceipt } from "./types.js";
import { splitMessage } from "./format.js";

export interface VerifiedLineMessage {
  signatureVerified: true;
  webhookEventId: string;
  messageId: string;
  userId: string;
  conversationId: string;
  text: string;
  timestamp: number;
}
export interface LineTransport {
  start(signal: AbortSignal, onMessage: (message: VerifiedLineMessage) => Promise<void>): Promise<void>;
  pushMessage(conversationId: string, text: string): Promise<{ messageId?: string }>;
  stop(): Promise<void>;
}

/** Adapter for LINE Messaging API events emitted only after raw-body signature verification. */
export function createLineAdapter(transport: LineTransport): MessagingAdapter {
  let running = false;
  return {
    platform: "line",
    async start(signal, onMessage) {
      if (running) return;
      running = true;
      try {
        await transport.start(signal, async (event) => {
          if (event.signatureVerified !== true || !event.webhookEventId || !event.messageId ||
              !event.userId || !event.conversationId || typeof event.text !== "string" ||
              !Number.isFinite(event.timestamp)) return;
          const inbound: InboundMessage = {
            platform: "line",
            messageId: event.webhookEventId + ":" + event.messageId,
            identity: {
              platform: "line",
              userId: event.userId,
              channelId: event.conversationId,
              conversationId: event.conversationId,
            },
            text: event.text,
            attachments: [],
            receivedAt: event.timestamp,
          };
          await onMessage(inbound);
        });
      } catch (error) {
        running = false;
        throw error;
      }
    },
    async send(message: OutboundMessage): Promise<DeliveryReceipt> {
      if (!running) return { state: "failed", errorCode: "transport_stopped" };
      try {
        const chunks = splitMessage(message.text, 4_900);
        let providerMessageId: string | undefined;
        for (const chunk of chunks) {
          const result = await transport.pushMessage(message.conversationId, chunk);
          providerMessageId = result.messageId ?? providerMessageId;
        }
        return { state: "sent", ...(providerMessageId ? { providerMessageId } : {}) };
      } catch {
        return { state: "failed", errorCode: "line_delivery_failed" };
      }
    },
    async stop() {
      if (!running) return;
      running = false;
      await transport.stop();
    },
  };
}
