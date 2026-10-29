import type { MessagingAdapter, InboundMessage, DeliveryReceipt, OutboundMessage } from "./types.js";
import { splitMessage } from "./format.js";

export interface VerifiedLineMessage {
  signatureVerified: true;
  eventId: string;
  messageId: string;
  userId: string;
  conversationId: string;
  text: string;
  createdAt: number;
}
export interface LineTransport {
  start(signal: AbortSignal, onMessage: (message: VerifiedLineMessage) => Promise<void>): Promise<void>;
  pushMessage(to: string, text: string): Promise<{ messageId?: string }>;
  stop(): Promise<void>;
}

/** Adapter for LINE Messaging API events already verified by the transport. */
export function createLineAdapter(transport: LineTransport): MessagingAdapter {
  let running = false;
  return {
    platform: "line",
    async start(signal, onMessage) {
      if (running) return;
      running = true;
      await transport.start(signal, async (event) => {
        if (event.signatureVerified !== true || !event.eventId || !event.messageId ||
            !event.userId || !event.conversationId || typeof event.text !== "string") return;
        const inbound: InboundMessage = {
          platform: "line",
          messageId: event.eventId,
          identity: {
            platform: "line",
            userId: event.userId,
            channelId: event.conversationId,
            conversationId: event.conversationId,
          },
          text: event.text,
          attachments: [],
          receivedAt: event.createdAt,
        };
        await onMessage(inbound);
      });
    },
    async send(message: OutboundMessage): Promise<DeliveryReceipt> {
      try {
        let lastId: string | undefined;
        for (const chunk of splitMessage(message.text, 5_000)) {
          const sent = await transport.pushMessage(message.conversationId, chunk);
          lastId = sent.messageId ?? lastId;
        }
        return { state: "sent", ...(lastId ? { providerMessageId: lastId } : {}) };
      } catch {
        return { state: "failed", errorCode: "line_delivery_failed" };
      }
    },
    async stop() { running = false; await transport.stop(); },
  };
}
