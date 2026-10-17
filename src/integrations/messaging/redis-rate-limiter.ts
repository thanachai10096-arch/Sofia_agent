import { createHash } from "node:crypto";
import type { MessagingRateLimiter } from "./gateway.js";

/**
 * Minimal node-redis v4-compatible contract. The Lua script executes atomically
 * on Redis, so all application workers share one fixed-window counter.
 */
export interface RedisEvalClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export interface RedisMessagingRateLimiterOptions {
  client: RedisEvalClient;
  /** Prefix should identify this app/environment (for example, "sofia:prod:msg-rate"). */
  keyPrefix?: string;
}

/** Atomically increments a counter and applies its TTL only on the first hit. */
export const REDIS_MESSAGING_RATE_LIMIT_SCRIPT = [
  "local count = redis.call('INCR', KEYS[1])",
  "if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end",
  "if count <= tonumber(ARGV[2]) then return 1 else return 0 end",
].join("\n");

/**
 * Shared Redis-backed fixed-window limiter.
 *
 * Redis errors are intentionally propagated; createMessagingGateway catches them
 * and fails closed. Only the hashed scope key is sent to Redis, not raw user IDs.
 */
export class RedisMessagingRateLimiter implements MessagingRateLimiter {
  private readonly client: RedisEvalClient;
  private readonly keyPrefix: string;

  constructor(options: RedisMessagingRateLimiterOptions) {
    if (!options?.client || typeof options.client.eval !== "function") {
      throw new Error("Redis messaging rate limiter requires a Redis eval client.");
    }
    const prefix = options.keyPrefix ?? "sofia:messaging:rate";
    if (!prefix.trim() || prefix.length > 128 || /[\\s{}]/.test(prefix)) {
      throw new Error("Invalid Redis messaging rate-limit key prefix.");
    }
    this.client = options.client;
    this.keyPrefix = prefix;
  }

  async consume(input: { key: string; limit: number; windowMs: number; now: number }): Promise<boolean> {
    if (!input || typeof input.key !== "string" || input.key.length === 0 || input.key.length > 2_048) {
      throw new Error("Invalid messaging rate-limit key.");
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10_000) {
      throw new Error("Invalid messaging rate limit.");
    }
    if (!Number.isSafeInteger(input.windowMs) || input.windowMs < 1_000 || input.windowMs > 86_400_000) {
      throw new Error("Invalid messaging rate window.");
    }
    if (!Number.isFinite(input.now)) throw new Error("Invalid messaging rate-limit timestamp.");

    const digest = createHash("sha256").update(input.key).digest("hex");
    const result = await this.client.eval(REDIS_MESSAGING_RATE_LIMIT_SCRIPT, {
      keys: [`${this.keyPrefix}:${digest}`],
      arguments: [String(input.windowMs), String(input.limit)],
    });
    if (result === 1 || result === 1n || result === "1") return true;
    if (result === 0 || result === 0n || result === "0") return false;
    throw new Error("Redis returned an invalid messaging rate-limit result.");
  }
}
