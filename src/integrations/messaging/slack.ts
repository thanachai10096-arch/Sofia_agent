import type { MessagingAdapter, InboundMessage, DeliveryReceipt, OutboundMessage } from "./types.js";
import { splitMessage } from "./format.js";

export interface VerifiedSlackMessage {
  /** Must only be emitted after verifySlackRequest accepts the exact raw request body. */
  signatureVerified: true;
  eventId: string;
  channel: string;
  user: string;
  ts: string;
  text?: string;
  botId?: string;
  subtype?: string;
  files?: Array<{ id: string; name?: string; mimetype?: string; size?: number; url_private?: string }>;
}
export interface SlackTransport {
  start(signal: AbortSignal, onMessage: (event: VerifiedSlackMessage) => Promise<void>): Promise<void>;
  postMessage(channel: string, text: string, threadTs?: string): Promise<{ messageId: string }>;
  stop(): Promise<void>;
}

/** Maps authenticated Slack Events API messages into Sofia's shared gateway contract. */
export function createSlackAdapter(transport: SlackTransport): MessagingAdapter {
  let running = false;
  return {
    platform: "slack",
    async start(signal, onMessage) {
      if (running) return;
      running = true;
      await transport.start(signal, async (event) => {
        if (event.signatureVerified !== true || !event.eventId || !event.channel || !event.user ||
            !event.ts || event.botId || event.subtype && event.subtype !== "file_share") return;
        const attachments = (event.files ?? []).slice(0, 50).map((file) => ({
          id: file.id,
          ...(file.name ? { filename: file.name } : {}),
          ...(file.mimetype ? { contentType: file.mimetype } : {}),
          ...(typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0 ? { sizeBytes: file.size } : {}),
          ...(file.url_private ? { url: file.url_private } : {}),
        }));
        const inbound: InboundMessage = {
          platform: "slack",
          messageId: event.eventId + ":" + event.ts,
          identity: {
            platform: "slack",
            userId: event.user,
            channelId: event.channel,
            conversationId: event.channel,
          },
          text: event.text ?? "",
          attachments,
          receivedAt: Number.isFinite(Number(event.ts)) ? Math.floor(Number(event.ts) * 1000) : Date.now(),
        };
        if (!inbound.text.trim() && attachments.length === 0) return;
        await onMessage(inbound);
      });
    },
    async send(message: OutboundMessage): Promise<DeliveryReceipt> {
      try {
        let lastId: string | undefined;
        for (const chunk of splitMessage(message.text, 39_000)) {
          const sent = await transport.postMessage(message.conversationId, chunk, message.replyToMessageId);
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
