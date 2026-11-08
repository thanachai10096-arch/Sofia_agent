import { createHash } from "node:crypto";
import type { RedisEvalClient } from "../integrations/messaging/redis-rate-limiter.js";

export const REDIS_DESKTOP_REPLAY_GUARD_SCRIPT =
  "return redis.call('SET', KEYS[1], '1', 'NX', 'PX', ARGV[1])";

/**
 * Shared atomic nonce store for horizontally scaled relay API workers.
 * Redis availability is mandatory: errors propagate so callers fail closed.
 */
export class RedisDesktopRelayReplayGuard {
  private readonly client: RedisEvalClient;
  private readonly keyPrefix: string;

  constructor(options: { client: RedisEvalClient; keyPrefix?: string }) {
    if (!options?.client || typeof options.client.eval !== "function") {
      throw new Error("Redis desktop relay replay guard requires a Redis eval client.");
    }
    const prefix = options.keyPrefix ?? "sofia:desktop:relay:nonce";
    if (!prefix.trim() || prefix.length > 128 || /[\s{}]/.test(prefix)) {
      throw new Error("Invalid Redis desktop relay replay key prefix.");
    }
    this.client = options.client;
    this.keyPrefix = prefix;
  }

  async consume(deviceId: string, nonce: string, expiresAt: number, now = Date.now()): Promise<boolean> {
    if (typeof deviceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(deviceId) ||
        typeof nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
        !Number.isSafeInteger(expiresAt) || expiresAt < 0 ||
        !Number.isSafeInteger(now) || now < 0) {
      throw new Error("Invalid desktop relay replay guard input.");
    }
    const ttlMs = expiresAt - now;
    if (ttlMs <= 0 || ttlMs > 30 * 60_000) return false;
    const digest = createHash("sha256").update(deviceId + "\n" + nonce, "utf8").digest("hex");
    const result = await this.client.eval(REDIS_DESKTOP_REPLAY_GUARD_SCRIPT, {
      keys: [this.keyPrefix + ":" + digest],
      arguments: [String(ttlMs)],
    });
    if (result === "OK" || result === true) return true;
    if (result === null || result === undefined || result === false || result === 0) return false;
    throw new Error("Redis returned an unexpected desktop relay replay guard response.");
  }
}
