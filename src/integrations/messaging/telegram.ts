import type { MessagingAdapter, InboundMessage, DeliveryReceipt, OutboundMessage } from "./types.js";
import { splitMessage } from "./format.js";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    chat: { id: number | string; type: string; title?: string; username?: string };
    from?: { id: number | string; username?: string; first_name?: string };
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  };
}
export interface TelegramTransport {
  start(signal: AbortSignal, onUpdate: (update: TelegramUpdate) => Promise<void>): Promise<void>;
  sendMessage(chatId: string, text: string, replyToMessageId?: string): Promise<{ messageId: string }>;
  stop(): Promise<void>;
}
/** Adapter mapping already-authenticated Telegram updates to the shared gateway contract. */
export function createTelegramAdapter(transport: TelegramTransport): MessagingAdapter {
  let running = false;
  return {
    platform: "telegram",
    async start(signal, onMessage) {
      if (running) return;
      running = true;
      await transport.start(signal, async (update) => {
        const msg = update.message;
        if (!msg || !Number.isSafeInteger(update.update_id) || !Number.isSafeInteger(msg.message_id) ||
            !msg.from || !msg.chat || (!msg.text && !msg.document)) return;
        const channelId = String(msg.chat.id);
        const userId = String(msg.from.id);
        const attachments = msg.document ? [{
          id: msg.document.file_id,
          ...(msg.document.file_name ? { filename: msg.document.file_name } : {}),
          ...(msg.document.mime_type ? { contentType: msg.document.mime_type } : {}),
          ...(typeof msg.document.file_size === "number" ? { sizeBytes: msg.document.file_size } : {}),
        }] : [];
        const inbound: InboundMessage = {
          platform: "telegram", messageId: String(msg.message_id),
          identity: { platform: "telegram", userId, channelId, conversationId: channelId,
            ...(msg.from.username ? { displayName: msg.from.username } : {}) },
          text: msg.text ?? "", attachments, receivedAt: msg.date * 1000,
        };
        await onMessage(inbound);
      });
    },
    async send(message: OutboundMessage): Promise<DeliveryReceipt> {
      try {
        let lastId: string | undefined;
        for (const chunk of splitMessage(message.text, 4096)) {
          const sent = await transport.sendMessage(message.conversationId, chunk,
            message.replyToMessageId ?? lastId);
          lastId = sent.messageId;
        }
        return { state: "sent", ...(lastId ? { providerMessageId: lastId } : {}) };
      } catch {
        return { state: "failed", errorCode: "telegram_delivery_failed" };
      }
    },
    async stop() { running = false; await transport.stop(); },
  };
}
