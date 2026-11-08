import { createHash } from "node:crypto";
import type { RedisEvalClient } from "../integrations/messaging/redis-rate-limiter.js";
import type { DesktopEnrollmentChallenge, DesktopEnrollmentChallengeStore } from "./device-enrollment.js";

export const REDIS_DESKTOP_ENROLLMENT_CREATE_SCRIPT = "return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])";
export const REDIS_DESKTOP_ENROLLMENT_CONSUME_SCRIPT = [
  "local value = redis.call('GET', KEYS[1])",
  "if not value then return false end",
  "redis.call('DEL', KEYS[1])",
  "return value",
].join("\n");

export interface RedisDesktopEnrollmentChallengeStoreOptions {
  client: RedisEvalClient;
  keyPrefix?: string;
}

/** Redis-backed, single-use enrollment challenges shared across API workers. */
export class RedisDesktopEnrollmentChallengeStore implements DesktopEnrollmentChallengeStore {
  private readonly client: RedisEvalClient;
  private readonly keyPrefix: string;

  constructor(options: RedisDesktopEnrollmentChallengeStoreOptions) {
    if (!options?.client || typeof options.client.eval !== "function") {
      throw new Error("Redis desktop enrollment store requires a Redis eval client.");
    }
    const prefix = options.keyPrefix ?? "sofia:desktop:enrollment";
    if (!prefix.trim() || prefix.length > 128 || /[\s{}]/.test(prefix)) {
      throw new Error("Invalid Redis desktop enrollment key prefix.");
    }
    this.client = options.client;
    this.keyPrefix = prefix;
  }

  async create(tokenHash: string, challenge: DesktopEnrollmentChallenge, ttlSeconds: number): Promise<void> {
    validateHash(tokenHash);
    if (!challenge || typeof challenge.ownerId !== "string" || !challenge.ownerId.trim() ||
        !Number.isSafeInteger(challenge.expiresAt) || challenge.expiresAt < 0 ||
        !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 600) {
      throw new Error("Invalid desktop enrollment challenge.");
    }
    const result = await this.client.eval(REDIS_DESKTOP_ENROLLMENT_CREATE_SCRIPT, {
      keys: [this.key(tokenHash)],
      arguments: [JSON.stringify(challenge), String(ttlSeconds)],
    });
    if (result === "OK" || result === true) return;
    throw new Error("Could not create desktop enrollment challenge.");
  }

  async consume(tokenHash: string): Promise<DesktopEnrollmentChallenge | null> {
    validateHash(tokenHash);
    const result = await this.client.eval(REDIS_DESKTOP_ENROLLMENT_CONSUME_SCRIPT, {
      keys: [this.key(tokenHash)],
      arguments: [],
    });
    if (result === null || result === undefined || result === false) return null;
    if (typeof result !== "string") throw new Error("Redis returned an invalid desktop enrollment challenge.");
    let parsed: unknown;
    try { parsed = JSON.parse(result); } catch { throw new Error("Stored desktop enrollment challenge is malformed."); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Stored desktop enrollment challenge is malformed.");
    }
    const value = parsed as Record<string, unknown>;
    if (typeof value.ownerId !== "string" || !value.ownerId.trim() ||
        typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt)) {
      throw new Error("Stored desktop enrollment challenge is malformed.");
    }
    return { ownerId: value.ownerId, expiresAt: value.expiresAt };
  }

  private key(tokenHash: string): string {
    return this.keyPrefix + ":" + tokenHash;
  }
}

function validateHash(value: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Invalid desktop enrollment token hash.");
  }
}
