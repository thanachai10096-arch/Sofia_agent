import { createSignedMessagingContext, createChatCommandHandler,
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
  /** Opt-in chat-first mode for integrations where plain text is a task. */
  allowPlainText?: boolean;
  maxTaskCharacters?: number;
  messagingContextSecret?: string;
  /** Called after the API accepts a run; implementations should schedule completion reporting without blocking polling. */
  onAccepted?: (input: { runId: string; runStatus: string; message: InboundMessage }) => void;
}

/** Maps the gateway identity to Sofia's existing chat authorization contract. */
export function createMessagingAccessCheck(policy: ChatAccessPolicy) {
  return async (input: { platform: "telegram" | "discord" | "slack" | "line" | "whatsapp" | "matrix"; userId: string; channelId: string }) =>
    policy.isAllowed({
      platform: input.platform,
      senderId: input.userId,
      conversationId: input.channelId,
    });
}

/**
 * Bridges normalized inbound messages to Sofia's existing command dispatcher.
 * Plain-text dispatch is opt-in so existing integrations keep command-only behavior.
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
    messagingContextSecret: options.messagingContextSecret,
  });

  return async function onMessage(message: InboundMessage): Promise<string | void> {
    const text = message.text.trim();
    if (text === "/work" || text.startsWith("/work ") || text.startsWith("/work\t")) {
      const allowed = await options.accessPolicy.isAllowed({
        platform: message.platform,
        senderId: message.identity.userId,
        conversationId: message.identity.conversationId,
      });
      if (!allowed) return "Access denied.";
      if (!options.messagingContextSecret?.trim() || !options.client.continuousWorkAction) {
        return "Continuous-work chat controls are not configured on this Sofia server.";
      }
      const args = text.slice("/work".length).trim();
      const separator = args.indexOf(" ");
      const action = (separator < 0 ? args : args.slice(0, separator)).trim().toLowerCase();
      const rest = separator < 0 ? "" : args.slice(separator + 1).trim();
      let payload: { action: string; task?: string; workId?: string };
      if (action === "create" && rest) payload = { action, task: rest };
      else if (action === "list" && !rest) payload = { action };
      else if (["status", "continue", "resume", "pause", "stop"].includes(action) && rest && !rest.includes(" ")) payload = { action, workId: rest };
      else return "Usage: /work create <task> | /work list | /work status <id> | /work continue <id> | /work resume <id> | /work pause <id> | /work stop <id>";
      const signedTask = JSON.stringify(payload);
      const dedupeKey = "work|" + [message.platform, message.identity.conversationId, message.messageId]
        .map((part) => `${part.length}:${part}`).join("|");
      if (!(await options.deduplicator.claim(dedupeKey))) return;
      try {
        const messagingContext = createSignedMessagingContext({
          platform: message.platform,
          userId: message.identity.userId,
          conversationId: message.identity.conversationId,
          messageId: message.messageId,
          signedTask,
        }, options.messagingContextSecret);
        const result = await options.client.continuousWorkAction({ signedTask, messagingContext });
        const work = result.work as { id?: string; status?: string; iteration?: number; lastSummary?: string } | undefined;
        if (action === "create" && work?.id) return `Created continuous task ${work.id} (paused). Use /work continue ${work.id} to start it.`;
        if (action === "list") {
          const items = Array.isArray(result.work) ? result.work as Array<{ id?: string; status?: string; iteration?: number; task?: string }> : [];
          return items.length ? items.map((item) => `• ${item.id} — ${item.status}, iteration ${item.iteration}: ${(item.task ?? "").slice(0, 100)}`).join("\n") : "You have no continuous tasks yet.";
        }
        if (action === "status" && work) return `Task ${work.id}: ${work.status}, iteration ${work.iteration}.${work.lastSummary ? "\n" + work.lastSummary : ""}`;
        if (action === "continue" || action === "resume") return `Sofia accepted ${action} for task ${String(result.workId ?? work?.id ?? payload.workId)}.`;
        if ((action === "pause" || action === "stop") && work) return `Task ${work.id} is now ${work.status}.`;
        if (result.error === "continuous_work_not_found") return "I couldn't find that task for your chat account.";
        return "Sofia processed the continuous-work request.";
      } catch {
        await options.deduplicator.release(dedupeKey);
        return "Sofia couldn't process that continuous-work request. Check the task ID and try again.";
      }
    }
    const explicitCommand = text === prefix || text.startsWith(prefix + " ") || text.startsWith(prefix + "\t");
    if (!explicitCommand && !options.allowPlainText) return;
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
          ? `Usage: ${prefix} <task>`
          : "Task is too long. Please shorten it.";
      case "duplicate":
      case "ignored":
        return;
    }
  };
}
