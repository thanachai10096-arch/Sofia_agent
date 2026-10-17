import {
  createChatCommandHandler,
  type ChatAccessPolicy,
  type ChatMessageDeduplicator,
  type ChatRunStarter,
} from "../chat-adapter.js";
import type { InboundMessage } from "./types.js";

export interface SofiaMessagingHandlerOptions {
  /** Existing Sofia SDK/API client; credentials remain server-side. */
  client: ChatRunStarter;
  /** Existing access policy and atomic deduplicator from chat-adapter.ts. */
  accessPolicy: ChatAccessPolicy;
  deduplicator: ChatMessageDeduplicator;
  /** Exact command prefix, e.g. /run or /run@SofiaBot. Defaults to /run. */
  commandPrefix?: string;
  maxTaskCharacters?: number;
}

/** Maps the gateway identity to Sofia's existing chat authorization contract. */
export function createMessagingAccessCheck(policy: ChatAccessPolicy) {
  return async (input: { platform: "telegram" | "discord" | "slack"; userId: string; channelId: string }) =>
    policy.isAllowed({
      platform: input.platform,
      senderId: input.userId,
      conversationId: input.channelId,
    });
}

/**
 * Bridges normalized inbound messages to Sofia's existing command dispatcher.
 * Only explicit command messages start a run; ordinary chat and attachments do not.
 * Do not also pass this same deduplicator to createMessagingGateway, because the
 * existing command handler claims the provider/channel/message key itself.
 */
export function createSofiaMessagingHandler(options: SofiaMessagingHandlerOptions) {
  const prefix = options.commandPrefix ?? "/run";
  if (!prefix.trim() || prefix.length > 128 || /[\r\n\0]/.test(prefix)) {
    throw new Error("commandPrefix must be a non-empty single-line command.");
  }
  const handleCommand = createChatCommandHandler({
    client: options.client,
    accessPolicy: options.accessPolicy,
    deduplicator: options.deduplicator,
    maxTaskCharacters: options.maxTaskCharacters,
  });

  return async function onMessage(message: InboundMessage): Promise<string | void> {
    const text = message.text.trim();
    if (text !== prefix && !text.startsWith(prefix + " ") && !text.startsWith(prefix + "\t")) return;
    const task = text.slice(prefix.length).trim();
    const result = await handleCommand({
      platform: message.platform,
      messageId: message.messageId,
      senderId: message.identity.userId,
      conversationId: message.identity.conversationId,
      command: "run",
      task,
    });
    switch (result.status) {
      case "accepted":
        return `Sofia accepted the task (run ${result.runId}, status: ${result.runStatus}).`;
      case "forbidden":
        return "Access denied.";
      case "rejected":
        return result.reason === "empty_task"
          ? `Usage: ${prefix} <task>`
          : "Task is too long. Please shorten it.";
      case "duplicate":
      case "ignored":
        return;
    }
  };
}
