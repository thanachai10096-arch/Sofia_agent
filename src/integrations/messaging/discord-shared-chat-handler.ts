import type { JobRuntime } from "../../brain/job-runtime.js";
import type { ChatMessageDeduplicator } from "../chat-adapter.js";
import { createSofiaMessagingHandler } from "./sofia-handler.js";
import type { VerifiedDiscordMessage } from "./discord.js";
import { buildDiscordSessionContext, waitForDiscordTask } from "./discord-durable-job.js";

export interface DiscordChatSender {
  sendMessage(channelId: string, text: string, replyToMessageId?: string, interactionId?: string): Promise<{ messageId: string }>;
}

export interface DiscordSharedChatHandlerOptions {
  runtime: JobRuntime;
  sender: DiscordChatSender;
  deduplicator: ChatMessageDeduplicator;
  allowedUserIds: ReadonlySet<string>;
  allowedChannelIds: ReadonlySet<string>;
  signal: AbortSignal;
  commandPrefix?: string;
  onError?: (kind: "completion_delivery_failed" | "completion_wait_failed") => void;
}

/**
 * Routes Discord run requests through the same transport-neutral chat dispatcher
 * used by Telegram. The Discord transport remains responsible for signature
 * verification and interaction acknowledgement; this adapter owns task
 * normalization, allowlist re-checks, durable deduplication, session context,
 * Brain job submission, and final result delivery.
 */
export function createDiscordSharedChatHandler(options: DiscordSharedChatHandlerOptions) {
  const client = {
    async start(input: { task: string; context?: string; sessionId?: string }) {
      options.signal.throwIfAborted();
      const sessionKey = input.sessionId;
      const memory = sessionKey
        ? await buildDiscordSessionContext(options.runtime, sessionKey)
        : "";
      const context = [input.context, memory].filter((value) => typeof value === "string" && value.trim()).join("\n\n");
      const job = await options.runtime.submit({
        task: input.task,
        principalId: "discord:" + [...options.allowedUserIds].find((id) => id === currentSenderId) ,
        ownerKeyId: "discord:" + currentSenderId,
        notificationChannelId: currentChannelId,
        ...(sessionKey ? { sessionKey } : {}),
        sessionTask: input.task,
        ...(context ? { context } : {}),
      });
      return { id: job.id, status: job.status };
    },
  };

  let currentSenderId = "";
  let currentChannelId = "";
  const handler = createSofiaMessagingHandler({
    client,
    accessPolicy: {
      isAllowed(input) {
        return input.platform === "discord" &&
          options.allowedUserIds.has(input.senderId) &&
          options.allowedChannelIds.has(input.conversationId);
      },
    },
    deduplicator: options.deduplicator,
    commandPrefix: options.commandPrefix ?? "/run",
    naturalLanguageEnabled: true,
    onAccepted: ({ runId, message }) => {
      const channelId = message.identity.conversationId;
      void waitForDiscordTask({ id: runId, runtime: options.runtime }, { signal: options.signal })
        .then(async (result) => {
          const label = result.status === "completed"
            ? "Sofia completed the task."
            : "Sofia job " + result.status + ".";
          const response = label + "\nJob ID: " + result.id + "\n" + result.summary;
          await options.sender.sendMessage(channelId, response.length > 1_700 ? response.slice(0, 1_690) + "… (truncated)" : response);
          await options.runtime.markNotificationDelivered?.(result.id);
        })
        .catch(async () => {
          options.onError?.("completion_wait_failed");
          try {
            await options.sender.sendMessage(channelId, "Sofia could not report the final result for job " + runId + ". Check the job status.");
          } catch {
            options.onError?.("completion_delivery_failed");
          }
        });
    },
  });

  return async (message: VerifiedDiscordMessage): Promise<string | void> => {
    currentSenderId = message.author.id;
    currentChannelId = message.channelId;
    try {
      return await handler({
        platform: "discord",
        messageId: message.id,
        identity: {
          platform: "discord",
          userId: message.author.id,
          channelId: message.channelId,
          conversationId: message.channelId,
          ...(message.author.username ? { displayName: message.author.username } : {}),
        },
        text: message.content,
        attachments: (message.attachments ?? []).map((item) => ({
          id: item.id,
          ...(item.filename ? { filename: item.filename } : {}),
          ...(item.contentType ? { contentType: item.contentType } : {}),
          ...(typeof item.sizeBytes === "number" ? { sizeBytes: item.sizeBytes } : {}),
          ...(item.url ? { url: item.url } : {}),
        })),
        receivedAt: message.createdAt,
      });
    } finally {
      currentSenderId = "";
      currentChannelId = "";
    }
  };
}
