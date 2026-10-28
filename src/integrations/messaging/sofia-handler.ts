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
  /** Exact command prefix, e.g. /run or /run@SofiaBot. Set false to accept natural chat; defaults to /run for backwards compatibility. */
  commandPrefix?: string | false;
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
 * Only explicit command messages start a run; ordinary chat and attachments do not.
 * Do not also pass this same deduplicator to createMessagingGateway, because the
 * existing command handler claims the provider/channel/message key itself.
 */
export function createSofiaMessagingHandler(options: SofiaMessagingHandlerOptions) {
  const prefix = options.commandPrefix === false ? false : options.commandPrefix ?? "/run";
  if (prefix !== false && (!prefix.trim() || prefix.length > 128 || /[\r\n\0]/.test(prefix))) {
    throw new Error("commandPrefix must be false or a non-empty single-line command.");
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
    let task: string;
    if (prefix === false) {
      // Natural mode accepts ordinary text, but keeps common slash commands out of the task queue.
      if (text === "/run" || text.startsWith("/run ") || text.startsWith("/run\\t")) {
        task = text.slice(4).trim();
      } else if (text.startsWith("/")) {
        return;
      } else {
        task = text;
      }
    } else {
      if (text !== prefix && !text.startsWith(prefix + " ") && !text.startsWith(prefix + "\\t")) return;
      task = text.slice(prefix.length).trim();
    }
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
