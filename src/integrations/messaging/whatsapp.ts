import type { MessagingAdapter, InboundMessage, DeliveryReceipt, OutboundMessage } from "./types.js";
import { splitMessage } from "./format.js";

export interface VerifiedWhatsAppMessage {
  signatureVerified: true;
  messageId: string;
  phoneNumberId: string;
  senderPhoneId: string;
  text: string;
  createdAt: number;
}
export interface WhatsAppTransport {
  start(signal: AbortSignal, onMessage: (message: VerifiedWhatsAppMessage) => Promise<void>): Promise<void>;
  sendMessage(toPhoneId: string, text: string): Promise<{ messageId?: string }>;
  stop(): Promise<void>;
}

/** Adapter for Meta WhatsApp Cloud API text messages. */
export function createWhatsAppAdapter(transport: WhatsAppTransport): MessagingAdapter {
  let running = false;
  return {
    platform: "whatsapp",
    async start(signal, onMessage) {
      if (running) return;
      running = true;
      await transport.start(signal, async (event) => {
        if (event.signatureVerified !== true || !event.messageId || !event.phoneNumberId ||
            !event.senderPhoneId || typeof event.text !== "string") return;
        const inbound: InboundMessage = {
          platform: "whatsapp",
          messageId: event.messageId,
          identity: {
            platform: "whatsapp",
            userId: event.senderPhoneId,
            channelId: event.senderPhoneId,
            conversationId: event.senderPhoneId,
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
        for (const chunk of splitMessage(message.text, 4_000)) {
          const sent = await transport.sendMessage(message.conversationId, chunk);
          lastId = sent.messageId ?? lastId;
        }
        return { state: "sent", ...(lastId ? { providerMessageId: lastId } : {}) };
      } catch {
        return { state: "failed", errorCode: "whatsapp_delivery_failed" };
      }
    },
    async stop() { running = false; await transport.stop(); },
  };
}
