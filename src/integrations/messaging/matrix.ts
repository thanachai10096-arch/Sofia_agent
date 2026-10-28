import type { MessagingAdapter, InboundMessage, DeliveryReceipt, OutboundMessage } from "./types.js";
import { splitMessage } from "./format.js";

export interface VerifiedMatrixMessage {
  authenticated: true;
  eventId: string;
  roomId: string;
  senderId: string;
  text: string;
  createdAt: number;
}
export interface MatrixTransport {
  start(signal: AbortSignal, onMessage: (message: VerifiedMatrixMessage) => Promise<void>): Promise<void>;
  sendMessage(roomId: string, text: string): Promise<{ messageId: string }>;
  stop(): Promise<void>;
}

/** Adapter for Matrix events received from an authenticated homeserver sync. */
export function createMatrixAdapter(transport: MatrixTransport): MessagingAdapter {
  let running = false;
  return {
    platform: "matrix",
    async start(signal, onMessage) {
      if (running) return;
      running = true;
      try {
        await transport.start(signal, async (event) => {
          if (event.authenticated !== true || !event.eventId || !event.roomId ||
              !event.senderId || typeof event.text !== "string") return;
          const message: InboundMessage = {
            platform: "matrix",
            messageId: event.eventId,
            identity: {
              platform: "matrix",
              userId: event.senderId,
              channelId: event.roomId,
              conversationId: event.roomId,
            },
            text: event.text,
            attachments: [],
            receivedAt: event.createdAt,
          };
          await onMessage(message);
        });
      } catch (error) {
        running = false;
        throw error;
      }
    },
    async send(message: OutboundMessage): Promise<DeliveryReceipt> {
      try {
        let lastId: string | undefined;
        for (const chunk of splitMessage(message.text, 30_000)) {
          const sent = await transport.sendMessage(message.conversationId, chunk);
          lastId = sent.messageId;
        }
        return { state: "sent", ...(lastId ? { providerMessageId: lastId } : {}) };
      } catch {
        return { state: "failed", errorCode: "matrix_delivery_failed" };
      }
    },
    async stop() { running = false; await transport.stop(); },
  };
}
