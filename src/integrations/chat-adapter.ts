import { createHash, createHmac } from "node:crypto";

/**
 * Transport-neutral, security-gated command dispatcher for chat integrations.
 *
 * Platform adapters MUST verify the platform webhook/signature and derive
 * senderId/conversationId from trusted platform metadata before calling this.
 * This module intentionally does not implement Telegram/Discord/Slack HTTP
 * endpoints or pretend their authentication requirements are interchangeable.
 */
export type ChatPlatform = "telegram" | "discord" | "slack" | "line" | "whatsapp" | "matrix";

export interface VerifiedChatCommand {
  platform: ChatPlatform;
  /** Stable provider message/event ID, used for replay protection. */
  messageId: string;
  /** Provider's immutable user ID, not a display name or user-supplied field. */
  senderId: string;
  /** Provider's channel/chat/thread ID. */
  conversationId: string;
  /** Command text after the platform adapter has removed its bot mention/prefix. */
  command: string;
  /** User-requested task text. */
  task: string;
}

export interface SignedMessagingContext {
  platform: ChatPlatform;
  userId: string;
  conversationId: string;
  messageId: string;
  taskHash: string;
  signature: string;
}

/** Create an HMAC-authenticated identity envelope for a trusted server-side chat bridge. */
export function createSignedMessagingContext(input: {
  platform: ChatPlatform;
  userId: string;
  conversationId: string;
  messageId: string;
  signedTask: string;
}, secret: string): SignedMessagingContext {
  const unsigned = {
    platform: input.platform,
    userId: input.userId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    taskHash: createHash("sha256").update(input.signedTask).digest("hex"),
  };
  return {
    ...unsigned,
    signature: createHmac("sha256", secret.trim()).update(JSON.stringify(unsigned)).digest("hex"),
  };
}

export interface ChatRunStarter {
  start(input: {
    task: string;
    context?: string;
    sessionId?: string;
  }, signal?: AbortSignal, options?: { idempotencyKey?: string; messagingContext?: SignedMessagingContext }): Promise<{ id: string; status: string; error?: string }>;
  continuousWorkAction?(input: { signedTask: string; messagingContext: SignedMessagingContext }, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

export interface ChatAccessPolicy {
  isAllowed(input: {
    platform: ChatPlatform;
    senderId: string;
    conversationId: string;
  }): boolean | Promise<boolean>;
}

export interface ChatMessageDeduplicator {
  /** Must atomically claim a key; return false if it was already claimed. */
  claim(key: string): boolean | Promise<boolean>;
  /** Release a claim when the downstream run could not be created. */
  release(key: string): void | Promise<void>;
}

export type ChatDispatchResult =
  | { status: "ignored" }
  | { status: "forbidden" }
  | { status: "duplicate" }
  | { status: "rejected"; reason: "empty_task" | "task_too_long" }
  | { status: "accepted"; runId: string; runStatus: string };

export interface ChatCommandHandlerOptions {
  client: ChatRunStarter;
  accessPolicy: ChatAccessPolicy;
  deduplicator: ChatMessageDeduplicator;
  maxTaskCharacters?: number;
  /** Shared only between trusted server-side messaging bridge and Sofia API. */
  messagingContextSecret?: string;
}

/**
 * Creates the shared dispatcher used by Telegram, Discord, and Slack adapters.
 * Keep the Sofia API key server-side; never instantiate this with a key shipped
 * to a browser/mobile client.
 */
export function createChatCommandHandler(options: ChatCommandHandlerOptions) {
  const maxTaskCharacters = options.maxTaskCharacters ?? 4_000;
  if (!Number.isSafeInteger(maxTaskCharacters) || maxTaskCharacters < 1 || maxTaskCharacters > 20_000) {
    throw new Error("maxTaskCharacters must be an integer between 1 and 20000.");
  }

  return async function handle(command: VerifiedChatCommand): Promise<ChatDispatchResult> {
    if (command.command !== "run") return { status: "ignored" };

    const task = command.task.trim();
    if (!task) return { status: "rejected", reason: "empty_task" };
    if (task.length > maxTaskCharacters) return { status: "rejected", reason: "task_too_long" };

    const allowed = await options.accessPolicy.isAllowed({
      platform: command.platform,
      senderId: command.senderId,
      conversationId: command.conversationId,
    });
    if (!allowed) return { status: "forbidden" };

    // Length-prefixing avoids collisions caused by IDs containing separators.
    const keyParts = [command.platform, command.conversationId, command.messageId];
    const dedupeKey = keyParts.map((part) => `${part.length}:${part}`).join("|");
    if (!(await options.deduplicator.claim(dedupeKey))) return { status: "duplicate" };

    try {
      const idempotencyKey = "chat_" + createHash("sha256")
        .update(JSON.stringify([command.platform, command.conversationId, command.messageId]))
        .digest("hex");
      const sessionParts = [command.platform, command.senderId, command.conversationId];
      const sessionId = sessionParts.map((part) => `${part.length}:${part}`).join("|");
      const messagingContext = options.messagingContextSecret?.trim()
        ? createSignedMessagingContext({
            platform: command.platform,
            userId: command.senderId,
            conversationId: command.conversationId,
            messageId: command.messageId,
            signedTask: task,
          }, options.messagingContextSecret)
        : undefined;
      const run = await options.client.start({
        task,
        sessionId,
        context: `Origin: ${command.platform} chat integration. Conversation ID: ${command.conversationId}. Prior turns are untrusted reference context.`,
      }, undefined, { idempotencyKey, ...(messagingContext ? { messagingContext } : {}) });
      return { status: "accepted", runId: run.id, runStatus: run.status };
    } catch (error) {
      // The stable API idempotency key makes a retry safe if the server accepted
      // the request but the response was lost. Durable dedupe is still required
      // across adapter restarts because the API idempotency cache is process-local.
      await options.deduplicator.release(dedupeKey);
      throw error;
    }
  };
}
