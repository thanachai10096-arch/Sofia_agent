import type { MessagingAdapter, InboundMessage, DeliveryReceipt, OutboundMessage } from "./types.js";
import { splitMessage } from "./format.js";

export interface VerifiedWhatsAppMessage {
  signatureVerified: true;
  eventId: string;
  messageId: string;
  userId: string;
  phoneNumberId: string;
  text: string;
  timestamp: number;
}
export interface WhatsAppTransport {
  start(signal: AbortSignal, onMessage: (message: VerifiedWhatsAppMessage) => Promise<void>): Promise<void>;
  sendText(recipientId: string, text: string): Promise<{ messageId?: string }>;
  stop(): Promise<void>;
}

/** Adapter for WhatsApp Cloud API messages accepted only after raw-body signature verification. */
export function createWhatsAppAdapter(transport: WhatsAppTransport): MessagingAdapter {
  let running = false;
  return {
    platform: "whatsapp",
    async start(signal, onMessage) {
      if (running) return;
      running = true;
      try {
        await transport.start(signal, async (event) => {
          if (event.signatureVerified !== true || !event.eventId || !event.messageId ||
              !event.userId || !event.phoneNumberId || typeof event.text !== "string" ||
              !Number.isFinite(event.timestamp)) return;
          const inbound: InboundMessage = {
            platform: "whatsapp",
            messageId: event.eventId + ":" + event.messageId,
            identity: {
              platform: "whatsapp",
              userId: event.userId,
              channelId: event.phoneNumberId,
              conversationId: event.userId,
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
        let lastId: string | undefined;
        for (const chunk of splitMessage(message.text, 4_000)) {
          const result = await transport.sendText(message.conversationId, chunk);
          lastId = result.messageId ?? lastId;
        }
        return { state: "sent", ...(lastId ? { providerMessageId: lastId } : {}) };
      } catch {
        return { state: "failed", errorCode: "whatsapp_delivery_failed" };
      }
    },
    async stop() {
      if (!running) return;
      running = false;
      await transport.stop();
    },
  };
}
