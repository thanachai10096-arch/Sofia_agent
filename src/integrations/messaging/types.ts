import type { ChatPlatform } from "../chat-adapter.js";

export type DeliveryState = "queued" | "sent" | "failed" | "unknown";
export interface MessagingIdentity {
  platform: ChatPlatform;
  userId: string;
  channelId: string;
  conversationId: string;
  displayName?: string;
}
export interface MessagingAttachment {
  id: string;
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
  /** Provider URL is untrusted; consumers must fetch through a guarded downloader. */
  url?: string;
}
export interface InboundMessage {
  platform: ChatPlatform;
  messageId: string;
  identity: MessagingIdentity;
  text: string;
  attachments: MessagingAttachment[];
  receivedAt: number;
}
export interface OutboundMessage {
  conversationId: string;
  text: string;
  replyToMessageId?: string;
}
export interface DeliveryReceipt {
  state: DeliveryState;
  providerMessageId?: string;
  errorCode?: string;
}
export interface MessagingAdapter {
  readonly platform: ChatPlatform;
  start(signal: AbortSignal): Promise<void>;
  send(message: OutboundMessage): Promise<DeliveryReceipt>;
  stop(): Promise<void>;
}
export interface MessagingLogger {
  info(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
  warn(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
}
