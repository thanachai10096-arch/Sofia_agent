import type { ChatPlatform } from "../chat-adapter.js";
import type { InboundMessage, MessagingAdapter, MessagingLogger, OutboundMessage } from "./types.js";

export interface MessagingGatewayOptions {
  adapters: readonly MessagingAdapter[];
  enabled?: boolean;
  allowUser?: (input: { platform: ChatPlatform; userId: string; channelId: string }) => boolean | Promise<boolean>;
  onMessage: (message: InboundMessage, signal: AbortSignal) => Promise<string | void>;
  logger?: MessagingLogger;
  maxMessagesPerWindow?: number;
  rateWindowMs?: number;
  now?: () => number;
}
export interface MessagingGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  dispatch(message: InboundMessage): Promise<{ status: "disabled" | "forbidden" | "rate_limited" | "handled" }>;
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
  function key(platform: string, user: string, channel: string) {
    return [platform, user, channel].map((part) => `${part.length}:${part}`).join("|");
  }
  return {
    async start() {
      if (!enabled || started || stopped) return;
      started = true;
      try {
        await Promise.all([...adapters.values()].map((adapter) => adapter.start(controller.signal, async (message) => { await this.dispatch(message); })));
      } catch (error) {
        controller.abort();
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
      if (identity.platform !== message.platform || !identity.userId || !identity.channelId || !identity.conversationId) {
        return { status: "forbidden" };
      }
      if (!(await (options.allowUser?.({ platform: message.platform, userId: identity.userId, channelId: identity.channelId }) ?? false))) {
        log?.warn("messaging_access_denied", { platform: message.platform });
        return { status: "forbidden" };
      }
      const rateKey = key(message.platform, identity.userId, identity.channelId);
      const cutoff = now() - windowMs;
      const recent = (counts.get(rateKey) ?? []).filter((timestamp) => timestamp > cutoff);
      if (recent.length >= max) {
        counts.set(rateKey, recent);
        return { status: "rate_limited" };
      }
      recent.push(now());
      counts.set(rateKey, recent);
      const reply = await options.onMessage(message, controller.signal);
      if (reply?.trim()) {
        const adapter = adapters.get(message.platform);
        if (adapter) await adapter.send({ conversationId: identity.conversationId, text: reply });
      }
      return { status: "handled" };
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
