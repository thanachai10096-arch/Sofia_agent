import { createHash } from "node:crypto";
import type { RedisEvalClient } from "../integrations/messaging/redis-rate-limiter.js";
import type { DesktopDeviceRecord, DesktopDeviceRegistryStore } from "./device-registry.js";

export interface RedisDesktopDeviceRegistryStoreOptions {
  client: RedisEvalClient;
  /** Prefix must be environment-specific and contain no whitespace or braces. */
  keyPrefix?: string;
  /** Maximum number of registered devices per owner. Defaults to 25. */
  maxDevicesPerOwner?: number;
}

/**
 * Atomically create a device record and add it to its owner's index.
 * Both keys share a Redis Cluster hash tag derived from the owner ID.
 */
export const REDIS_DESKTOP_DEVICE_CREATE_SCRIPT = [
  "if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end",
  "if redis.call('SCARD', KEYS[2]) >= tonumber(ARGV[2]) then return -1 end",
  "redis.call('SET', KEYS[1], ARGV[1])",
  "redis.call('SADD', KEYS[2], KEYS[1])",
  "return 1",
].join("\n");

/** Read only when the serialized record still matches the requested owner/device. */
export const REDIS_DESKTOP_DEVICE_GET_SCRIPT = [
  "local value = redis.call('GET', KEYS[1])",
  "if not value then return false end",
  "local ok, record = pcall(cjson.decode, value)",
  "if not ok or record.ownerId ~= ARGV[1] or record.id ~= ARGV[2] then return false end",
  "return value",
].join("\n");

/** Enumerate the owner index and return only valid, owner-bound records. */
export const REDIS_DESKTOP_DEVICE_LIST_SCRIPT = [
  "local keys = redis.call('SMEMBERS', KEYS[1])",
  "local result = {}",
  "for _, key in ipairs(keys) do",
  "  local value = redis.call('GET', key)",
  "  if value then",
  "    local ok, record = pcall(cjson.decode, value)",
  "    if ok and record.ownerId == ARGV[1] and type(record.id) == 'string' then",
  "      table.insert(result, value)",
  "    else",
  "      redis.call('SREM', KEYS[1], key)",
  "    end",
  "  else",
  "    redis.call('SREM', KEYS[1], key)",
  "  end",
  "end",
  "return result",
].join("\n");

/** Persist revocation in the same atomic operation used to read the record. */
export const REDIS_DESKTOP_DEVICE_REVOKE_SCRIPT = [
  "local value = redis.call('GET', KEYS[1])",
  "if not value then return 0 end",
  "local ok, record = pcall(cjson.decode, value)",
  "if not ok or record.ownerId ~= ARGV[1] or record.id ~= ARGV[2] then return 0 end",
  "if record.revokedAt ~= nil then return 0 end",
  "record.revokedAt = tonumber(ARGV[3])",
  "redis.call('SET', KEYS[1], cjson.encode(record))",
  "return 1",
].join("\n");

/**
 * Redis-backed owner-scoped device registry.
 *
 * Redis must be configured with durable persistence/replication appropriate to
 * the deployment. Secrets are expected to be encrypted by DesktopDeviceCredentialVault
 * before records are passed to this store. Raw owner IDs are never used in Redis keys.
 */
export class RedisDesktopDeviceRegistryStore implements DesktopDeviceRegistryStore {
  private readonly client: RedisEvalClient;
  private readonly keyPrefix: string;
  private readonly maxDevicesPerOwner: number;

  constructor(options: RedisDesktopDeviceRegistryStoreOptions) {
    if (!options?.client || typeof options.client.eval !== "function") {
      throw new Error("Redis desktop device registry requires a Redis eval client.");
    }
    const prefix = options.keyPrefix ?? "sofia:desktop:devices";
    if (!prefix.trim() || prefix.length > 128 || /[\\s{}]/.test(prefix)) {
      throw new Error("Invalid Redis desktop device registry key prefix.");
    }
    const maxDevices = options.maxDevicesPerOwner ?? 25;
    if (!Number.isSafeInteger(maxDevices) || maxDevices < 1 || maxDevices > 1_000) {
      throw new Error("Invalid maximum devices per owner.");
    }
    this.client = options.client;
    this.keyPrefix = prefix;
    this.maxDevicesPerOwner = maxDevices;
  }

  async create(record: DesktopDeviceRecord): Promise<void> {
    validateRecord(record);
    const keys = this.keys(record.ownerId, record.id);
    const result = await this.client.eval(REDIS_DESKTOP_DEVICE_CREATE_SCRIPT, {
      keys: [keys.device, keys.index],
      arguments: [JSON.stringify(record), String(this.maxDevicesPerOwner)],
    });
    if (isResult(result, 1)) return;
    if (isResult(result, 0)) throw new Error("Desktop device already exists.");
    if (isResult(result, -1)) throw new Error("Desktop device limit reached for owner.");
    throw new Error("Redis returned an invalid desktop device create result.");
  }

  async getOwned(ownerId: string, deviceId: string): Promise<DesktopDeviceRecord | null> {
    validateOwnerAndDevice(ownerId, deviceId);
    const { device } = this.keys(ownerId, deviceId);
    const result = await this.client.eval(REDIS_DESKTOP_DEVICE_GET_SCRIPT, {
      keys: [device],
      arguments: [ownerId, deviceId],
    });
    if (result === null || result === undefined || result === false) return null;
    return parseOwnedRecord(result, ownerId, deviceId);
  }

  async listOwned(ownerId: string): Promise<readonly DesktopDeviceRecord[]> {
    validateOwner(ownerId);
    const { index } = this.keys(ownerId, "index-placeholder");
    const result = await this.client.eval(REDIS_DESKTOP_DEVICE_LIST_SCRIPT, {
      keys: [index],
      arguments: [ownerId],
    });
    if (!Array.isArray(result)) throw new Error("Redis returned an invalid desktop device list.");
    const records: DesktopDeviceRecord[] = [];
    for (const value of result) {
      const record = parseOwnedRecord(value, ownerId);
      records.push(record);
    }
    return records;
  }

  async revokeOwned(ownerId: string, deviceId: string, revokedAt: number): Promise<boolean> {
    validateOwnerAndDevice(ownerId, deviceId);
    if (!Number.isSafeInteger(revokedAt) || revokedAt < 0) {
      throw new Error("Invalid desktop device revocation timestamp.");
    }
    const { device } = this.keys(ownerId, deviceId);
    const result = await this.client.eval(REDIS_DESKTOP_DEVICE_REVOKE_SCRIPT, {
      keys: [device],
      arguments: [ownerId, deviceId, String(revokedAt)],
    });
    if (isResult(result, 1)) return true;
    if (isResult(result, 0)) return false;
    throw new Error("Redis returned an invalid desktop device revoke result.");
  }

  private keys(ownerId: string, deviceId: string): { device: string; index: string } {
    const ownerHash = createHash("sha256").update(ownerId).digest("hex");
    const slot = `{owner-${ownerHash}}`;
    return {
      device: `${this.keyPrefix}:${slot}:device:${deviceId}`,
      index: `${this.keyPrefix}:${slot}:index`,
    };
  }
}

function validateOwner(ownerId: string): void {
  if (typeof ownerId !== "string" || ownerId.trim().length === 0 || ownerId.length > 256) {
    throw new Error("Invalid desktop device owner ID.");
  }
}

function validateOwnerAndDevice(ownerId: string, deviceId: string): void {
  validateOwner(ownerId);
  if (typeof deviceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(deviceId)) {
    throw new Error("Invalid desktop device ID.");
  }
}

function validateRecord(record: DesktopDeviceRecord): void {
  if (!record || typeof record !== "object") throw new Error("Invalid desktop device record.");
  validateOwnerAndDevice(record.ownerId, record.id);
  if (typeof record.displayName !== "string" || record.displayName.trim().length === 0 || record.displayName.length > 120) {
    throw new Error("Invalid desktop device display name.");
  }
  if (!Array.isArray(record.capabilities) || record.capabilities.length > 32 ||
      !record.capabilities.every((capability) => typeof capability === "string")) {
    throw new Error("Invalid desktop device capabilities.");
  }
  if (!record.credential || record.credential.version !== 1 || record.credential.algorithm !== "aes-256-gcm" ||
      typeof record.credential.iv !== "string" || typeof record.credential.ciphertext !== "string" ||
      typeof record.credential.tag !== "string") {
    throw new Error("Invalid encrypted desktop device credential.");
  }
  if (!Number.isSafeInteger(record.createdAt) || record.createdAt < 0 ||
      (record.lastSeenAt !== undefined && (!Number.isSafeInteger(record.lastSeenAt) || record.lastSeenAt < 0)) ||
      (record.revokedAt !== undefined && (!Number.isSafeInteger(record.revokedAt) || record.revokedAt < 0))) {
    throw new Error("Invalid desktop device timestamps.");
  }
}

function parseOwnedRecord(value: unknown, ownerId: string, deviceId?: string): DesktopDeviceRecord {
  if (typeof value !== "string" || value.length > 32_768) {
    throw new Error("Redis returned an invalid desktop device record.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Redis returned malformed desktop device data."); }
  validateRecord(parsed as DesktopDeviceRecord);
  const record = parsed as DesktopDeviceRecord;
  if (record.ownerId !== ownerId || (deviceId !== undefined && record.id !== deviceId)) {
    throw new Error("Redis returned a desktop device outside the requested owner scope.");
  }
  return record;
}

function isResult(value: unknown, expected: number): boolean {
  return value === expected || value === BigInt(expected) || value === String(expected);
}
