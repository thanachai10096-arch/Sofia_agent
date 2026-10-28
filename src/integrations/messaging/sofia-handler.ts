import {
  createChatCommandHandler,
  type ChatAccessPolicy,
  type ChatMessageDeduplicator,
  type ChatRunStarter,
} from "../chat-adapter.js";
import type { InboundMessage } from "./types.js";
import type { ChatPlatform } from "../chat-adapter.js";

export interface SofiaMessagingHandlerOptions {
  /** Existing Sofia SDK/API client; credentials remain server-side. */
  client: ChatRunStarter;
  /** Existing access policy and atomic deduplicator from chat-adapter.ts. */
  accessPolicy: ChatAccessPolicy;
  deduplicator: ChatMessageDeduplicator;
  /** "natural" runs ordinary text without a prefix; "command" requires the configured prefix. Defaults to "natural". */
  mode?: "natural" | "command";
  /** Exact command prefix, e.g. /run or /run@SofiaBot. Defaults to /run. */
  commandPrefix?: string;
  maxTaskCharacters?: number;
  /** Called after the API accepts a run; implementations should schedule completion reporting without blocking polling. */
  onAccepted?: (input: { runId: string; runStatus: string; message: InboundMessage }) => void;
}

/** Maps the gateway identity to Sofia's existing chat authorization contract. */
export function createMessagingAccessCheck(policy: ChatAccessPolicy) {
  return async (input: { platform: ChatPlatform; userId: string; channelId: string }) =>
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
  const mode = options.mode ?? "natural";
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
    const explicitCommand = text === prefix || text.startsWith(prefix + " ") || text.startsWith(prefix + "\t");
    if (mode === "command" && !explicitCommand) return;
    // Keep conventional bot commands available; ordinary text is the task in natural mode.
    if (!explicitCommand && text.startsWith("/")) return;
    const task = explicitCommand ? text.slice(prefix.length).trim() : text;
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
          ? (mode === "command" ? `Usage: ${prefix} <task>` : "Please send a task or message for Sofia.")
          : "Task is too long. Please shorten it.";
      case "duplicate":
      case "ignored":
        return;
    }
  };
}
