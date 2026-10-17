import type { ChatPlatform, ChatMessageDeduplicator } from "../chat-adapter.js";
import type { InboundMessage, MessagingAdapter, MessagingLogger, OutboundMessage } from "./types.js";

export interface MessagingGatewayOptions {
  adapters: readonly MessagingAdapter[];
  enabled?: boolean;
  allowUser?: (input: { platform: ChatPlatform; userId: string; channelId: string }) => boolean | Promise<boolean>;
  /** Reuse the existing atomic deduplicator where available; no second store is created here. */
  deduplicator?: ChatMessageDeduplicator;
  onMessage: (message: InboundMessage, signal: AbortSignal) => Promise<string | void>;
  logger?: MessagingLogger;
  maxMessagesPerWindow?: number;
  rateWindowMs?: number;
  now?: () => number;
}
export interface MessagingGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  dispatch(message: InboundMessage): Promise<{ status: "disabled" | "forbidden" | "duplicate" | "rate_limited" | "handled" }>;
  send(platform: ChatPlatform, message: OutboundMessage): Promise<boolean>;
}
export function createMessagingGateway(options: MessagingGatewayOptions): MessagingGateway {
  const enabled = options.enabled ?? false;
  const max = options.maxMessagesPerWindow ?? 10;
  const windowMs = options.rateWindowMs ?? 60_000;
  if (!Number.isSafeInteger(max) || max < 1 || max > 10_000) throw new Error("Invalid messaging rate limit.");
  if (!Number.isSafeInteger(windowMs) || windowMs < 1_000 || windowMs > 86_400_000) throw new Error("Invalid messaging rate window.");
  const adapters = new Map<ChatPlatform, MessagingAdapter>();
  for (const adapter of options.adapters) {
    if (adapters.has(adapter.platform)) throw new Error("Duplicate messaging adapter.");
    adapters.set(adapter.platform, adapter);
  }
  const counts = new Map<string, number[]>();
  const controller = new AbortController();
  let started = false;
  let stopped = false;
  const now = options.now ?? Date.now;
  const log = options.logger;
  function key(...parts: string[]) {
    return parts.map((part) => `${part.length}:${part}`).join("|");
  }
  return {
    async start() {
      if (!enabled || started || stopped) return;
      started = true;
      try {
        await Promise.all([...adapters.values()].map((adapter) => adapter.start(controller.signal, async (message) => {
          try {
            await this.dispatch(message);
          } catch (error) {
            log?.warn("messaging_dispatch_failed", {
              platform: message.platform,
              errorType: error instanceof Error ? error.name : "unknown",
            });
          }
        })));
      } catch (error) {
        controller.abort();
        stopped = true;
        await Promise.allSettled([...adapters.values()].map((adapter) => adapter.stop()));
        started = false;
        log?.warn("messaging_start_failed", { errorType: error instanceof Error ? error.name : "unknown" });
        throw error;
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      controller.abort();
      await Promise.allSettled([...adapters.values()].map((adapter) => adapter.stop()));
      started = false;
      counts.clear();
    },
    async dispatch(message) {
      if (!enabled || stopped) return { status: "disabled" };
      const identity = message.identity;
      if (identity.platform !== message.platform || !identity.userId || identity.userId.length > 256 ||
          !identity.channelId || identity.channelId.length > 256 || !identity.conversationId ||
          identity.conversationId.length > 256 || !message.messageId || message.messageId.length > 512 ||
          typeof message.text !== "string" || message.text.length > 100_000 ||
          !Array.isArray(message.attachments) || message.attachments.length > 50) {
        return { status: "forbidden" };
      }
      let allowed = false;
      try {
        allowed = await (options.allowUser?.({
          platform: message.platform,
          userId: identity.userId,
          channelId: identity.channelId,
        }) ?? false);
      } catch (error) {
        log?.warn("messaging_policy_failed", {
          platform: message.platform,
          errorType: error instanceof Error ? error.name : "unknown",
        });
      }
      if (!allowed) {
        log?.warn("messaging_access_denied", { platform: message.platform });
        return { status: "forbidden" };
      }
      const rateKey = key(message.platform, identity.userId, identity.channelId);
      const cutoff = now() - windowMs;
      if (counts.size >= 10_000 && !counts.has(rateKey)) {
        for (const [storedKey, timestamps] of counts) {
          const fresh = timestamps.filter((timestamp) => timestamp > cutoff);
          if (fresh.length) counts.set(storedKey, fresh);
          else counts.delete(storedKey);
        }
        if (counts.size >= 10_000) return { status: "rate_limited" };
      }
      const recent = (counts.get(rateKey) ?? []).filter((timestamp) => timestamp > cutoff);
      if (recent.length >= max) {
        counts.set(rateKey, recent);
        return { status: "rate_limited" };
      }
      recent.push(now());
      counts.set(rateKey, recent);

      // The key shape matches the existing chat dispatcher's provider/channel/message scope.
      const dedupeKey = key(message.platform, identity.channelId, message.messageId);
      if (options.deduplicator && !(await options.deduplicator.claim(dedupeKey))) {
        return { status: "duplicate" };
      }
      try {
        const reply = await options.onMessage(message, controller.signal);
        if (reply?.trim()) {
          const adapter = adapters.get(message.platform);
          if (adapter) {
            const receipt = await adapter.send({
              conversationId: identity.conversationId,
              text: reply,
              ...(message.platform === "discord" ? { interactionId: message.messageId } : {}),
            });
            if (receipt.state !== "sent") log?.warn("messaging_reply_delivery_failed", { platform: message.platform });
          }
        }
        return { status: "handled" };
      } catch (error) {
        if (options.deduplicator) await options.deduplicator.release(dedupeKey);
        throw error;
      }
    },
    async send(platform, message) {
      if (!enabled || stopped) return false;
      const adapter = adapters.get(platform);
      if (!adapter) return false;
      const receipt = await adapter.send(message);
      return receipt.state === "sent";
    },
  };
}
