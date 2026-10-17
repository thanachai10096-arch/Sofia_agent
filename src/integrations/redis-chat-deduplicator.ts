import { createHash, randomUUID } from "node:crypto";
import type { ChatMessageDeduplicator } from "../chat-adapter.js";
import type { RedisEvalClient } from "./redis-rate-limiter.js";

/** Atomically claim a message key for the TTL if it has not already been claimed. */
export const REDIS_CHAT_DEDUPE_CLAIM_SCRIPT = [
  "local claimed = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])",
  "if claimed then return 1 else return 0 end",
].join("\n");

/** Release only the claim token owned by this process. */
export const REDIS_CHAT_DEDUPE_RELEASE_SCRIPT = [
  "if redis.call('GET', KEYS[1]) == ARGV[1] then",
  "  return redis.call('DEL', KEYS[1])",
  "end",
  "return 0",
].join("\n");

export interface RedisChatMessageDeduplicatorOptions {
  client: RedisEvalClient;
  /** Prefix should identify the app/environment and avoid whitespace/braces. */
  keyPrefix?: string;
  /** How long a claimed message remains deduplicated. Defaults to 24 hours. */
  ttlMs?: number;
  /** Bound per-process release-token bookkeeping. Defaults to 10,000 claims. */
  maxLocalClaims?: number;
}

interface LocalClaim {
  token: string;
  expiresAt: number;
}

/**
 * Redis-backed, cross-worker message deduplicator.
 *
 * Claims are atomic and expire automatically. Release uses a random ownership
 * token so a failed older run cannot delete a newer worker's claim. If local
 * bookkeeping is saturated, new claims fail closed instead of bypassing dedupe.
 */
export class RedisChatMessageDeduplicator implements ChatMessageDeduplicator {
  private readonly client: RedisEvalClient;
  private readonly keyPrefix: string;
  private readonly ttlMs: number;
  private readonly maxLocalClaims: number;
  private readonly localClaims = new Map<string, LocalClaim>();

  constructor(options: RedisChatMessageDeduplicatorOptions) {
    if (!options?.client || typeof options.client.eval !== "function") {
      throw new Error("Redis chat deduplicator requires a Redis eval client.");
    }
    const prefix = options.keyPrefix ?? "sofia:messaging:dedupe";
    if (!prefix.trim() || prefix.length > 128 || /[\s{}]/.test(prefix)) {
      throw new Error("Invalid Redis chat deduplication key prefix.");
    }
    const ttlMs = options.ttlMs ?? 86_400_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 604_800_000) {
      throw new Error("Invalid Redis chat deduplication TTL.");
    }
    const maxLocalClaims = options.maxLocalClaims ?? 10_000;
    if (!Number.isSafeInteger(maxLocalClaims) || maxLocalClaims < 1 || maxLocalClaims > 100_000) {
      throw new Error("Invalid Redis chat deduplication local claim limit.");
    }
    this.client = options.client;
    this.keyPrefix = prefix;
    this.ttlMs = ttlMs;
    this.maxLocalClaims = maxLocalClaims;
  }

  async claim(key: string): Promise<boolean> {
    if (typeof key !== "string" || key.length === 0 || key.length > 2_048) {
      throw new Error("Invalid chat deduplication key.");
    }
    const now = Date.now();
    for (const [storedKey, claim] of this.localClaims) {
      if (claim.expiresAt <= now) this.localClaims.delete(storedKey);
    }
    if (this.localClaims.size >= this.maxLocalClaims) return false;

    const digest = createHash("sha256").update(key).digest("hex");
    const redisKey = `${this.keyPrefix}:${digest}`;
    const token = randomUUID();
    const result = await this.client.eval(REDIS_CHAT_DEDUPE_CLAIM_SCRIPT, {
      keys: [redisKey],
      arguments: [token, String(this.ttlMs)],
    });
    if (result === 1 || result === 1n || result === "1") {
      this.localClaims.set(redisKey, { token, expiresAt: now + this.ttlMs });
      return true;
    }
    if (result === 0 || result === 0n || result === "0") return false;
    throw new Error("Redis returned an invalid chat deduplication result.");
  }

  async release(key: string): Promise<void> {
    if (typeof key !== "string" || key.length === 0 || key.length > 2_048) {
      throw new Error("Invalid chat deduplication key.");
    }
    const digest = createHash("sha256").update(key).digest("hex");
    const redisKey = `${this.keyPrefix}:${digest}`;
    const claim = this.localClaims.get(redisKey);
    if (!claim) return;

    const result = await this.client.eval(REDIS_CHAT_DEDUPE_RELEASE_SCRIPT, {
      keys: [redisKey],
      arguments: [claim.token],
    });
    if (result !== 0 && result !== 0n && result !== "0" && result !== 1 && result !== 1n && result !== "1") {
      throw new Error("Redis returned an invalid chat deduplication release result.");
    }
    this.localClaims.delete(redisKey);
  }
}
