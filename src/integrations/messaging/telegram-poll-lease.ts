import { randomUUID, createHash } from "node:crypto";

export interface TelegramPollLeaseRedisClient {
  set(key: string, value: string, options: { NX: true; PX: number }): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export interface TelegramPollLeaseHandle {
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

export interface TelegramPollLease {
  acquire(): Promise<TelegramPollLeaseHandle | undefined>;
}

export const TELEGRAM_POLL_LEASE_RENEW_SCRIPT = [
  "if redis.call('GET', KEYS[1]) == ARGV[1] then",
  "  return redis.call('PEXPIRE', KEYS[1], ARGV[2])",
  "end",
  "return 0",
].join("\n");

export const TELEGRAM_POLL_LEASE_RELEASE_SCRIPT = [
  "if redis.call('GET', KEYS[1]) == ARGV[1] then",
  "  return redis.call('DEL', KEYS[1])",
  "end",
  "return 0",
].join("\n");

/**
 * Redis-backed single-poller lease. A process may poll only while it owns the
 * lease; TTL expiry recovers ownership after a crash. The random owner token
 * prevents an expired former owner from renewing or deleting a successor's lock.
 */
export class RedisTelegramPollLease implements TelegramPollLease {
  private readonly client: TelegramPollLeaseRedisClient;
  private readonly key: string;
  private readonly ttlMs: number;

  constructor(options: { client: TelegramPollLeaseRedisClient; keyPrefix?: string; botIdentity: string; ttlMs?: number }) {
    if (!options?.client || typeof options.client.set !== "function" || typeof options.client.eval !== "function") {
      throw new Error("Telegram poll lease requires a Redis client with set and eval.");
    }
    if (!options.botIdentity.trim() || options.botIdentity.length > 256) {
      throw new Error("Invalid Telegram bot identity for poll lease.");
    }
    const prefix = options.keyPrefix ?? "sofia:telegram:poll";
    if (!prefix.trim() || prefix.length > 128 || /[\\s{}]/.test(prefix)) {
      throw new Error("Invalid Telegram poll lease key prefix.");
    }
    const ttlMs = options.ttlMs ?? 30_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 5_000 || ttlMs > 300_000) {
      throw new Error("Telegram poll lease TTL must be between 5 and 300 seconds.");
    }
    this.client = options.client;
    this.key = prefix + ":" + createHash("sha256").update(options.botIdentity).digest("hex");
    this.ttlMs = ttlMs;
  }

  async acquire(): Promise<TelegramPollLeaseHandle | undefined> {
    const owner = randomUUID();
    const claimed = await this.client.set(this.key, owner, { NX: true, PX: this.ttlMs });
    if (claimed !== "OK") return undefined;
    let released = false;
    return {
      renew: async () => {
        if (released) return false;
        const result = await this.client.eval(TELEGRAM_POLL_LEASE_RENEW_SCRIPT, {
          keys: [this.key], arguments: [owner, String(this.ttlMs)],
        });
        return result === 1 || result === 1n || result === "1";
      },
      release: async () => {
        if (released) return;
        released = true;
        await this.client.eval(TELEGRAM_POLL_LEASE_RELEASE_SCRIPT, {
          keys: [this.key], arguments: [owner],
        });
      },
    };
  }
}
