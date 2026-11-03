import { createHash } from "node:crypto";
import type { MessagingAdapter, InboundMessage, DeliveryReceipt, OutboundMessage } from "./types.js";
import { splitMessage } from "./format.js";

export interface VerifiedDiscordMessage {
  /** Must only be emitted by a transport after validating Discord's signature and timestamp. */
  signatureVerified: true;
  id: string;
  channelId: string;
  author: { id: string; username?: string; bot?: boolean };
  content: string;
  createdAt: number;
  attachments?: Array<{ id: string; filename?: string; contentType?: string; sizeBytes?: number; url?: string }>;
}
export interface DiscordTransport {
  start(signal: AbortSignal, onMessage: (message: VerifiedDiscordMessage) => Promise<void>): Promise<void>;
  sendMessage(channelId: string, text: string, replyToMessageId?: string, interactionId?: string, nonce?: string): Promise<{ messageId: string }>;
  stop(): Promise<void>;
}
/** Adapter for a Discord transport that verifies the provider request before emitting events. */
export function createDiscordAdapter(transport: DiscordTransport): MessagingAdapter {
  let running = false;
  return {
    platform: "discord",
    async start(signal, onMessage) {
      if (running) return;
      running = true;
      await transport.start(signal, async (event) => {
        if (event.signatureVerified !== true || !event.id || !event.channelId || !event.author?.id || event.author.bot) return;
        const inbound: InboundMessage = {
          platform: "discord", messageId: event.id,
          identity: { platform: "discord", userId: event.author.id, channelId: event.channelId,
            conversationId: event.channelId, ...(event.author.username ? { displayName: event.author.username } : {}) },
          text: event.content ?? "",
          attachments: (event.attachments ?? []).map((attachment) => ({
            id: attachment.id,
            ...(attachment.filename ? { filename: attachment.filename } : {}),
            ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
            ...(typeof attachment.sizeBytes === "number" ? { sizeBytes: attachment.sizeBytes } : {}),
            ...(attachment.url ? { url: attachment.url } : {}),
          })),
          receivedAt: event.createdAt,
        };
        await onMessage(inbound);
      });
    },
    async send(message: OutboundMessage): Promise<DeliveryReceipt> {
      try {
        let lastId: string | undefined;
        const chunks = splitMessage(message.text, 2000);
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index]!;
          // Discord accepts a bounded nonce for duplicate suppression on normal
          // channel messages. Derive a distinct stable nonce for each chunk.
          const nonce = message.deliveryId
            ? createHash("sha256").update(`${message.deliveryId}:${index}`).digest("hex").slice(0, 25)
            : undefined;
          const sent = await transport.sendMessage(message.conversationId, chunk,
            message.replyToMessageId ?? lastId, message.interactionId, nonce);
          lastId = sent.messageId;
        }
        return { state: "sent", ...(lastId ? { providerMessageId: lastId } : {}) };
      } catch {
        return { state: "failed", errorCode: "discord_delivery_failed" };
      }
    },
    async stop() { running = false; await transport.stop(); },
  };
}
