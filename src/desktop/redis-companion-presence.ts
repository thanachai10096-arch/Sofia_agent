import { createHash } from "node:crypto";
import type { RedisEvalClient } from "../integrations/messaging/redis-rate-limiter.js";

export interface DesktopCompanionPresence {
  ownerId: string;
  deviceId: string;
  sessionId: string;
  workerId: string;
  connectedAt: number;
  lastSeenAt: number;
}

export interface RedisDesktopCompanionPresenceOptions {
  client: RedisEvalClient;
  keyPrefix?: string;
  ttlSeconds?: number;
}

export const REDIS_DESKTOP_PRESENCE_REFRESH_SCRIPT = [
  "local raw = redis.call('GET', KEYS[1])",
  "if not raw then return 0 end",
  "local ok, presence = pcall(cjson.decode, raw)",
  "if not ok or type(presence) ~= 'table' or presence.sessionId ~= ARGV[1] then return 0 end",
  "presence.lastSeenAt = tonumber(ARGV[2])",
  "redis.call('SET', KEYS[1], cjson.encode(presence), 'EX', tonumber(ARGV[3]))",
  "return 1",
].join("\n");

export const REDIS_DESKTOP_PRESENCE_RELEASE_SCRIPT = [
  "local raw = redis.call('GET', KEYS[1])",
  "if not raw then return 0 end",
  "local ok, presence = pcall(cjson.decode, raw)",
  "if not ok or type(presence) ~= 'table' or presence.sessionId ~= ARGV[1] then return 0 end",
  "return redis.call('DEL', KEYS[1])",
].join("\n");

/**
 * Shared, TTL-backed Companion connection presence. A newer connection may
 * replace an older session; stale sockets cannot refresh or release it because
 * every mutation compares the session ID atomically in Redis.
 */
export class RedisDesktopCompanionPresenceStore {
  private readonly client: RedisEvalClient;
  private readonly prefix: string;
  private readonly ttlSeconds: number;

  constructor(options: RedisDesktopCompanionPresenceOptions) {
    if (!options?.client || typeof options.client.eval !== "function") {
      throw new Error("Redis desktop presence store requires a Redis eval client.");
    }
    const prefix = options.keyPrefix ?? "sofia:desktop:presence";
    if (!prefix.trim() || prefix.length > 128 || /[\s{}]/.test(prefix)) {
      throw new Error("Invalid Redis desktop presence key prefix.");
    }
    const ttlSeconds = options.ttlSeconds ?? 45;
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 10 || ttlSeconds > 300) {
      throw new Error("Desktop Companion presence TTL must be from 10 to 300 seconds.");
    }
    this.client = options.client;
    this.prefix = prefix;
    this.ttlSeconds = ttlSeconds;
  }

  async claim(input: {
    ownerId: string;
    deviceId: string;
    sessionId: string;
    workerId: string;
    now?: number;
  }): Promise<DesktopCompanionPresence> {
    validateOwnerDevice(input.ownerId, input.deviceId);
    validateToken(input.sessionId, "session ID");
    validateToken(input.workerId, "worker ID");
    const now = input.now ?? Date.now();
    validateTimestamp(now);
    const presence: DesktopCompanionPresence = {
      ownerId: input.ownerId,
      deviceId: input.deviceId,
      sessionId: input.sessionId,
      workerId: input.workerId,
      connectedAt: now,
      lastSeenAt: now,
    };
    const raw = JSON.stringify(presence);
    const result = await this.client.eval(
      "return redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))",
      { keys: [this.key(input.ownerId, input.deviceId)], arguments: [raw, String(this.ttlSeconds)] },
    );
    if (result !== "OK" && result !== true) {
      throw new Error("Redis failed to claim desktop Companion presence.");
    }
    return presence;
  }

  async refresh(ownerId: string, deviceId: string, sessionId: string, now = Date.now()): Promise<boolean> {
    validateOwnerDevice(ownerId, deviceId);
    validateToken(sessionId, "session ID");
    validateTimestamp(now);
    const result = await this.client.eval(REDIS_DESKTOP_PRESENCE_REFRESH_SCRIPT, {
      keys: [this.key(ownerId, deviceId)],
      arguments: [sessionId, String(now), String(this.ttlSeconds)],
    });
    return redisBoolean(result);
  }

  async release(ownerId: string, deviceId: string, sessionId: string): Promise<boolean> {
    validateOwnerDevice(ownerId, deviceId);
    validateToken(sessionId, "session ID");
    const result = await this.client.eval(REDIS_DESKTOP_PRESENCE_RELEASE_SCRIPT, {
      keys: [this.key(ownerId, deviceId)],
      arguments: [sessionId],
    });
    return redisBoolean(result);
  }

  async get(ownerId: string, deviceId: string): Promise<DesktopCompanionPresence | null> {
    validateOwnerDevice(ownerId, deviceId);
    const raw = await this.client.eval(
      "return redis.call('GET', KEYS[1])",
      { keys: [this.key(ownerId, deviceId)], arguments: [] },
    );
    if (raw === null || raw === undefined || raw === false) return null;
    if (typeof raw !== "string" || raw.length > 4_096) {
      throw new Error("Redis returned invalid desktop Companion presence.");
    }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error("Redis returned malformed desktop Companion presence."); }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Redis returned invalid desktop Companion presence.");
    }
    const presence = value as DesktopCompanionPresence;
    if (presence.ownerId !== ownerId || presence.deviceId !== deviceId ||
        typeof presence.sessionId !== "string" || typeof presence.workerId !== "string" ||
        !Number.isSafeInteger(presence.connectedAt) || !Number.isSafeInteger(presence.lastSeenAt)) {
      throw new Error("Redis returned presence outside the requested owner/device scope.");
    }
    return presence;
  }

  private key(ownerId: string, deviceId: string): string {
    const slot = `{owner-${createHash("sha256").update(ownerId).digest("hex")}-device-${createHash("sha256").update(deviceId).digest("hex")}}`;
    return `${this.prefix}:${slot}:session`;
  }
}

function validateOwnerDevice(ownerId: string, deviceId: string): void {
  if (typeof ownerId !== "string" || !ownerId.trim() || ownerId.length > 256) {
    throw new Error("Invalid desktop presence owner ID.");
  }
  if (typeof deviceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(deviceId)) {
    throw new Error("Invalid desktop presence device ID.");
  }
}

function validateToken(value: string, label: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new Error(`Invalid desktop Companion ${label}.`);
  }
}

function validateTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid desktop presence timestamp.");
}

function redisBoolean(value: unknown): boolean {
  if (value === 1 || value === 1n || value === "1" || value === true) return true;
  if (value === 0 || value === 0n || value === "0" || value === false || value === null) return false;
  throw new Error("Redis returned an invalid desktop presence mutation result.");
}
