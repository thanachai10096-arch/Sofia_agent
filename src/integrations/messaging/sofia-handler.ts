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
  /** Treat ordinary messages as tasks; disabled by default for backwards compatibility. */
  acceptPlainTextTasks?: boolean;
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
 * Plain-text task mode is opt-in so existing integrations retain command-only behavior.
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
    if (!text) return;
    if (text === "/start" || text === "/help") {
      return [
        "Hi! I'm Sofia Agent.",
        "",
        "Send a task as a normal message and I'll work on it.",
        "You can also use /run <task>.",
        "",
        "Examples:",
        "• Fix the TypeScript errors in this project",
        "• Explain what this error means: ...",
        "• Review the security of the Telegram integration",
        "",
        "Only messages from configured, authorized users and chats can start tasks.",
      ].join("\n");
    }

    const hasPrefix = text === prefix || text.startsWith(prefix + " ") || text.startsWith(prefix + "\t");
    if (!hasPrefix && !options.acceptPlainTextTasks) return;
    const task = hasPrefix ? text.slice(prefix.length).trim() : text;
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
        return `✅ Sofia received your task. Status: ${result.runStatus}.\nI'll send the result here when it's ready. (Run: ${result.runId})`;
      case "forbidden":
        return "Access denied.";
      case "rejected":
        return result.reason === "empty_task"
          ? `Usage: ${prefix} <task> — or just type your task as a normal message.`
          : "That message is too long. Please shorten it and try again.";
      case "duplicate":
      case "ignored":
        return;
    }
  };
}
