import { createHash } from "node:crypto";
import type { RedisEvalClient } from "../integrations/messaging/redis-rate-limiter.js";
import type { DesktopDeviceRecord, DesktopDeviceRegistryStore } from "./device-registry.js";

/** Atomically create a device record and add its key to the owner's index. */
export const REDIS_DESKTOP_DEVICE_CREATE_SCRIPT = [
  "local created = redis.call('SET', KEYS[1], ARGV[1], 'NX')",
  "if not created then return 0 end",
  "redis.call('SADD', KEYS[2], KEYS[1])",
  "return 1",
].join("\n");

/** Read a record by its owner-scoped, hashed Redis key. */
export const REDIS_DESKTOP_DEVICE_GET_SCRIPT = "return redis.call('GET', KEYS[1])";

/** List only records indexed for the authenticated owner. */
export const REDIS_DESKTOP_DEVICE_LIST_SCRIPT = [
  "local keys = redis.call('SMEMBERS', KEYS[1])",
  "local records = {}",
  "for _, key in ipairs(keys) do",
  "  local value = redis.call('GET', key)",
  "  if value then table.insert(records, value) end",
  "end",
  "return records",
].join("\n");

/** Owner-check and revoke in one Redis transaction; repeated revocation is a no-op. */
export const REDIS_DESKTOP_DEVICE_REVOKE_SCRIPT = [
  "local value = redis.call('GET', KEYS[1])",
  "if not value then return 0 end",
  "local record = cjson.decode(value)",
  "if record.ownerId ~= ARGV[1] then return 0 end",
  "if record.revokedAt ~= nil then return 0 end",
  "record.revokedAt = tonumber(ARGV[2])",
  "redis.call('SET', KEYS[1], cjson.encode(record))",
  "return 1",
].join("\n");

export interface RedisDesktopDeviceRegistryStoreOptions {
  client: RedisEvalClient;
  /** Use a distinct prefix for each Sofia environment. */
  keyPrefix?: string;
}

/**
 * Durable, cross-worker device registry backed by Redis.
 *
 * Owner and device identifiers are hashed before becoming Redis keys. The
 * encrypted credential envelope is stored as JSON; plaintext HMAC secrets
 * never enter Redis. All ownership checks are repeated against the record.
 */
export class RedisDesktopDeviceRegistryStore implements DesktopDeviceRegistryStore {
  private readonly client: RedisEvalClient;
  private readonly keyPrefix: string;

  constructor(options: RedisDesktopDeviceRegistryStoreOptions) {
    if (!options?.client || typeof options.client.eval !== "function") {
      throw new Error("Redis desktop device registry requires a Redis eval client.");
    }
    const prefix = options.keyPrefix ?? "sofia:desktop:devices";
    if (!prefix.trim() || prefix.length > 128 || /[\s{}]/.test(prefix)) {
      throw new Error("Invalid Redis desktop device registry key prefix.");
    }
    this.client = options.client;
    this.keyPrefix = prefix;
  }

  async create(record: DesktopDeviceRecord): Promise<void> {
    validateRecord(record);
    const serialized = JSON.stringify(record);
    const result = await this.client.eval(REDIS_DESKTOP_DEVICE_CREATE_SCRIPT, {
      keys: [this.recordKey(record.ownerId, record.id), this.ownerIndexKey(record.ownerId)],
      arguments: [serialized],
    });
    if (isRedisInteger(result, 1)) return;
    if (isRedisInteger(result, 0)) throw new Error("Desktop device ID already exists for this owner.");
    throw new Error("Redis returned an invalid desktop device create result.");
  }

  async getOwned(ownerId: string, deviceId: string): Promise<DesktopDeviceRecord | null> {
    validateIdentity(ownerId, deviceId);
    const result = await this.client.eval(REDIS_DESKTOP_DEVICE_GET_SCRIPT, {
      keys: [this.recordKey(ownerId, deviceId)],
      arguments: [],
    });
    if (result === null || result === undefined) return null;
    if (typeof result !== "string") throw new Error("Redis returned an invalid desktop device record.");
    const record = parseRecord(result);
    return record.ownerId === ownerId && record.id === deviceId ? record : null;
  }

  async listOwned(ownerId: string): Promise<readonly DesktopDeviceRecord[]> {
    validateOwner(ownerId);
    const result = await this.client.eval(REDIS_DESKTOP_DEVICE_LIST_SCRIPT, {
      keys: [this.ownerIndexKey(ownerId)],
      arguments: [],
    });
    if (!Array.isArray(result)) throw new Error("Redis returned an invalid desktop device list.");
    const records: DesktopDeviceRecord[] = [];
    for (const value of result) {
      if (typeof value !== "string") throw new Error("Redis returned an invalid desktop device list entry.");
      const record = parseRecord(value);
      // The index is not an authorization boundary; enforce ownership again.
      if (record.ownerId === ownerId) records.push(record);
    }
    return records;
  }

  async revokeOwned(ownerId: string, deviceId: string, revokedAt: number): Promise<boolean> {
    validateIdentity(ownerId, deviceId);
    if (!Number.isSafeInteger(revokedAt) || revokedAt < 0) {
      throw new Error("Invalid desktop device revocation timestamp.");
    }
    const result = await this.client.eval(REDIS_DESKTOP_DEVICE_REVOKE_SCRIPT, {
      keys: [this.recordKey(ownerId, deviceId)],
      arguments: [ownerId, String(revokedAt)],
    });
    if (isRedisInteger(result, 1)) return true;
    if (isRedisInteger(result, 0)) return false;
    throw new Error("Redis returned an invalid desktop device revoke result.");
  }

  private recordKey(ownerId: string, deviceId: string): string {
    // Keep the record and owner index in the same Redis Cluster hash slot.
    return this.keyPrefix + ":{" + digest(ownerId) + "}:record:" + digest(deviceId);
  }

  private ownerIndexKey(ownerId: string): string {
    return this.keyPrefix + ":{" + digest(ownerId) + "}:owner";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRedisInteger(value: unknown, expected: 0 | 1): boolean {
  return value === expected || value === BigInt(expected) || value === String(expected);
}

function validateOwner(ownerId: string): void {
  if (typeof ownerId !== "string" || ownerId.trim().length === 0 || ownerId.length > 256) {
    throw new Error("Invalid desktop device owner ID.");
  }
}

function validateIdentity(ownerId: string, deviceId: string): void {
  validateOwner(ownerId);
  if (typeof deviceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(deviceId)) {
    throw new Error("Invalid desktop device ID.");
  }
}

function validateRecord(record: DesktopDeviceRecord): void {
  if (!record || typeof record !== "object") throw new Error("Invalid desktop device record.");
  validateIdentity(record.ownerId, record.id);
  if (typeof record.displayName !== "string" || !record.displayName.trim() || record.displayName.length > 120 ||
      !Array.isArray(record.capabilities) || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 ||
      !record.credential || record.credential.version !== 1 || record.credential.algorithm !== "aes-256-gcm" ||
      typeof record.credential.iv !== "string" || typeof record.credential.ciphertext !== "string" ||
      typeof record.credential.tag !== "string") {
    throw new Error("Invalid desktop device record.");
  }
}

function parseRecord(serialized: string): DesktopDeviceRecord {
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw new Error("Stored desktop device record is malformed."); }
  validateRecord(value as DesktopDeviceRecord);
  return value as DesktopDeviceRecord;
}
