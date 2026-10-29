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
  /** Natural conversation in verified DMs or messages explicitly addressed to the bot. Enabled by default. */
  naturalChat?: boolean;
  maxTaskCharacters?: number;
  /** Called after the API accepts a run; implementations should schedule completion reporting without blocking polling. */
  onAccepted?: (input: { runId: string; runStatus: string; message: InboundMessage }) => void;
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
 * Natural chat is enabled by default only for verified direct messages or messages
 * explicitly addressed to the bot; group chatter and platform slash commands stay ignored.
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
    const isCommand = text === prefix || text.startsWith(prefix + " ") || text.startsWith(prefix + "\t");
    const isNaturalMessage = options.naturalChat !== false &&
      (message.directMessage === true || message.addressedToBot === true) &&
      text.length > 0 && !text.startsWith("/");
    if (!isCommand && !isNaturalMessage) return;
    const task = isCommand ? text.slice(prefix.length).trim() : text;
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
        try {
          options.onAccepted?.({ runId: result.runId, runStatus: result.runStatus, message });
        } catch {
          // Completion notifications must never prevent the normal acceptance acknowledgement.
        }
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
