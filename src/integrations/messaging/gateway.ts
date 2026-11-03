import type { ChatPlatform, ChatMessageDeduplicator } from "../chat-adapter.js";
import type { InboundMessage, MessagingAdapter, MessagingLogger, OutboundMessage } from "./types.js";

/**
 * Atomic fixed-window rate-limit contract for shared stores (for example Redis
 * or a database with an atomic upsert). Implementations must be safe across
 * concurrent workers; returning false rejects the request. Store errors fail closed.
 */
export interface MessagingRateLimiter {
  consume(input: { key: string; limit: number; windowMs: number; now: number }): boolean | Promise<boolean>;
}

export interface MessagingGatewayOptions {
  adapters: readonly MessagingAdapter[];
  enabled?: boolean;
  allowUser?: (input: { platform: ChatPlatform; userId: string; channelId: string }) => boolean | Promise<boolean>;
  /** Reuse the existing atomic deduplicator where available; no second store is created here. */
  deduplicator?: ChatMessageDeduplicator;
  /** Optional atomic shared limiter; omit to retain the backwards-compatible in-memory limiter. */
  rateLimiter?: MessagingRateLimiter;
  onMessage: (message: InboundMessage, signal: AbortSignal) => Promise<string | void>;
  logger?: MessagingLogger;
  maxMessagesPerWindow?: number;
  rateWindowMs?: number;
  now?: () => number;
}
export interface MessagingGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Explicitly restart all adapters after an operator has resolved provider conflicts. */
  restart(): Promise<void>;
  getStatus(): "disabled" | "idle" | "starting" | "running" | "stopped";
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
  let controller = new AbortController();
  let started = false;
  let stopped = false;
  let lifecycle: "idle" | "starting" | "running" | "stopped" = "idle";
  let generation = 0;
  const now = options.now ?? Date.now;
  const log = options.logger;
  function key(...parts: string[]) {
    return parts.map((part) => `${part.length}:${part}`).join("|");
  }
  return {
    async start() {
      if (!enabled || started) return;
      if (stopped) return;
      started = true;
      lifecycle = "starting";
      const runGeneration = ++generation;
      const runController = controller;
      try {
        await Promise.all([...adapters.values()].map((adapter) => adapter.start(runController.signal, async (message) => {
          // Fence callbacks from an adapter generation that has already stopped/restarted.
          if (runGeneration !== generation || runController.signal.aborted || stopped) return;
          try {
            await this.dispatch(message);
          } catch (error) {
            log?.warn("messaging_dispatch_failed", {
              platform: message.platform,
              errorType: error instanceof Error ? error.name : "unknown",
            });
          }
        })));
        if (runGeneration === generation && !stopped) lifecycle = "running";
      } catch (error) {
        if (runGeneration === generation) {
          runController.abort();
          stopped = true;
          lifecycle = "stopped";
          await Promise.allSettled([...adapters.values()].map((adapter) => adapter.stop()));
          started = false;
        }
        log?.warn("messaging_start_failed", { errorType: error instanceof Error ? error.name : "unknown" });
        throw error;
      }
    },
    async stop() {
      if (stopped && !started) return;
      // Invalidate callbacks before awaiting adapter shutdown.
      generation++;
      stopped = true;
      lifecycle = "stopped";
      controller.abort();
      await Promise.allSettled([...adapters.values()].map((adapter) => adapter.stop()));
      started = false;
      counts.clear();
    },
    async restart() {
      if (!enabled) return;
      await this.stop();
      controller = new AbortController();
      stopped = false;
      started = false;
      lifecycle = "idle";
      await this.start();
    },
    getStatus() {
      return enabled ? lifecycle : "disabled";
    },
    async dispatch(message) {
      const dispatchGeneration = generation;
      const dispatchSignal = controller.signal;
      const isCurrentDispatch = () =>
        dispatchGeneration === generation && !dispatchSignal.aborted && !stopped;
      if (!enabled || !isCurrentDispatch()) return { status: "disabled" };
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
      // Policy checks may await external stores. A restart during that wait must
      // not allow an old inbound message to cross into the new adapter generation.
      if (!isCurrentDispatch()) return { status: "disabled" };
      if (!allowed) {
        log?.warn("messaging_access_denied", { platform: message.platform });
        return { status: "forbidden" };
      }
      const rateKey = key(message.platform, identity.userId, identity.channelId);
      const currentTime = now();
      if (options.rateLimiter) {
        try {
          const permitted = await options.rateLimiter.consume({ key: rateKey, limit: max, windowMs, now: currentTime });
          if (!isCurrentDispatch()) return { status: "disabled" };
          if (!permitted) return { status: "rate_limited" };
        } catch (error) {
          log?.warn("messaging_rate_limiter_failed", {
            platform: message.platform,
            errorType: error instanceof Error ? error.name : "unknown",
          });
          return { status: "rate_limited" };
        }
      } else {
        const cutoff = currentTime - windowMs;
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
        recent.push(currentTime);
        counts.set(rateKey, recent);
      }

      // The key shape matches the existing chat dispatcher's provider/channel/message scope.
      const dedupeKey = key(message.platform, identity.channelId, message.messageId);
      if (options.deduplicator && !(await options.deduplicator.claim(dedupeKey))) {
        return { status: "duplicate" };
      }
      if (!isCurrentDispatch()) {
        if (options.deduplicator) await options.deduplicator.release(dedupeKey);
        return { status: "disabled" };
      }
      try {
        const reply = await options.onMessage(message, dispatchSignal);
        // A handler may ignore cancellation or finish just as a restart begins.
        // Never deliver its stale reply through an adapter from the new generation.
        if (!isCurrentDispatch()) return { status: "disabled" };
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
