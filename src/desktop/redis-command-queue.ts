import { createHash, randomUUID } from "node:crypto";
import type { RedisEvalClient } from "../integrations/messaging/redis-rate-limiter.js";

export type DesktopCommandStatus = "queued" | "leased" | "completed" | "failed";

export interface DesktopCommand {
  id: string;
  ownerId: string;
  deviceId: string;
  type: string;
  input: Record<string, unknown>;
  status: DesktopCommandStatus;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  maxAttempts: number;
  idempotencyKey?: string;
  leaseToken?: string;
  leaseExpiresAt?: number;
  result?: unknown;
  error?: string;
}

export interface EnqueueDesktopCommandInput {
  id?: string;
  ownerId: string;
  deviceId: string;
  type: string;
  input: Record<string, unknown>;
  idempotencyKey?: string;
  maxAttempts?: number;
  now?: number;
}

export interface RedisDesktopCommandQueueOptions {
  client: RedisEvalClient;
  keyPrefix?: string;
  maxPayloadBytes?: number;
  maxCommandsPerDevice?: number;
  idempotencyTtlSeconds?: number;
  terminalRetentionSeconds?: number;
}

export const REDIS_DESKTOP_COMMAND_ENQUEUE_SCRIPT = [
  "if redis.call('EXISTS', KEYS[4]) == 1 then return { 'duplicate', redis.call('GET', KEYS[4]) } end",
  "if (redis.call('ZCARD', KEYS[1]) + redis.call('ZCARD', KEYS[2])) >= tonumber(ARGV[4]) then return { 'full' } end",
  "if redis.call('HEXISTS', KEYS[3], ARGV[1]) == 1 then return { 'id_conflict' } end",
  "redis.call('HSET', KEYS[3], ARGV[1], ARGV[2])",
  "redis.call('ZADD', KEYS[1], tonumber(ARGV[3]), ARGV[1])",
  "if ARGV[5] ~= '' then redis.call('SET', KEYS[4], ARGV[1], 'EX', tonumber(ARGV[5])) end",
  "return { 'created', ARGV[1] }",
].join("\n");

export const REDIS_DESKTOP_COMMAND_CLAIM_SCRIPT = [
  "local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1], 'LIMIT', 0, 100)",
  "for _, id in ipairs(expired) do",
  "  local raw = redis.call('HGET', KEYS[3], id)",
  "  if raw then",
  "    local ok, command = pcall(cjson.decode, raw)",
  "    if ok and type(command) == 'table' and command.status == 'leased' then",
  "      command.leaseToken = nil; command.leaseExpiresAt = nil",
  "      if tonumber(command.attempts) >= tonumber(command.maxAttempts) then",
  "        command.status = 'failed'; command.error = 'Command lease expired after maximum attempts'; command.updatedAt = tonumber(ARGV[1]); redis.call('ZADD', KEYS[4], tonumber(ARGV[1]), id)",
  "      else",
  "        command.status = 'queued'; command.updatedAt = tonumber(ARGV[1]); redis.call('ZADD', KEYS[1], tonumber(ARGV[1]), id)",
  "      end",
  "      redis.call('HSET', KEYS[3], id, cjson.encode(command))",
  "    end",
  "  end",
  "  redis.call('ZREM', KEYS[2], id)",
  "end",
  "local ready = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 1)",
  "if #ready == 0 then return false end",
  "local id = ready[1]",
  "local raw = redis.call('HGET', KEYS[3], id)",
  "if not raw then redis.call('ZREM', KEYS[1], id); return false end",
  "local ok, command = pcall(cjson.decode, raw)",
  "if not ok or type(command) ~= 'table' or command.status ~= 'queued' then redis.call('ZREM', KEYS[1], id); return false end",
  "command.status = 'leased'; command.attempts = tonumber(command.attempts) + 1",
  "command.leaseToken = ARGV[3]; command.leaseExpiresAt = tonumber(ARGV[1]) + tonumber(ARGV[2]); command.updatedAt = tonumber(ARGV[1])",
  "redis.call('ZREM', KEYS[1], id); redis.call('ZADD', KEYS[2], command.leaseExpiresAt, id)",
  "redis.call('HSET', KEYS[3], id, cjson.encode(command))",
  "return cjson.encode(command)",
].join("\n");

export const REDIS_DESKTOP_COMMAND_COMPLETE_SCRIPT = [
  "local raw = redis.call('HGET', KEYS[2], ARGV[1])",
  "if not raw then return 0 end",
  "local ok, command = pcall(cjson.decode, raw)",
  "if not ok or type(command) ~= 'table' or command.status ~= 'leased' or command.leaseToken ~= ARGV[2] then return 0 end",
  "command.status = 'completed'; command.updatedAt = tonumber(ARGV[3]); command.result = cjson.decode(ARGV[4])",
  "command.leaseToken = nil; command.leaseExpiresAt = nil",
  "redis.call('ZREM', KEYS[1], ARGV[1]); redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(command)); redis.call('ZADD', KEYS[3], tonumber(ARGV[3]), ARGV[1])",
  "return 1",
].join("\n");

export const REDIS_DESKTOP_COMMAND_FAIL_SCRIPT = [
  "local raw = redis.call('HGET', KEYS[3], ARGV[1])",
  "if not raw then return 0 end",
  "local ok, command = pcall(cjson.decode, raw)",
  "if not ok or type(command) ~= 'table' or command.status ~= 'leased' or command.leaseToken ~= ARGV[2] then return 0 end",
  "command.error = ARGV[5]; command.leaseToken = nil; command.leaseExpiresAt = nil; command.updatedAt = tonumber(ARGV[3])",
  "redis.call('ZREM', KEYS[2], ARGV[1])",
  "if ARGV[4] == '1' and tonumber(command.attempts) < tonumber(command.maxAttempts) then",
  "  command.status = 'queued'; redis.call('ZADD', KEYS[1], tonumber(ARGV[3]) + tonumber(ARGV[6]), ARGV[1])",
  "else command.status = 'failed'; redis.call('ZADD', KEYS[4], tonumber(ARGV[3]), ARGV[1]) end",
  "redis.call('HSET', KEYS[3], ARGV[1], cjson.encode(command)); return 1",
].join("\n");

export const REDIS_DESKTOP_COMMAND_PRUNE_TERMINAL_SCRIPT = [
  "local ids = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))",
  "for _, id in ipairs(ids) do redis.call('HDEL', KEYS[1], id); redis.call('ZREM', KEYS[2], id) end",
  "return #ids",
].join("\n");

export const REDIS_DESKTOP_COMMAND_GET_SCRIPT = [
  "return redis.call('HGET', KEYS[1], ARGV[1])",
].join("\n");

/**
 * Owner/device-partitioned Redis command queue. Queue mutations are atomic Lua
 * operations so multiple Cloud workers cannot claim the same command lease.
 * This is a delivery primitive, not an exactly-once execution guarantee: a
 * Companion must deduplicate side effects by command ID before executing.
 */
export class RedisDesktopCommandQueue {
  private readonly client: RedisEvalClient;
  private readonly prefix: string;
  private readonly maxPayloadBytes: number;
  private readonly maxCommandsPerDevice: number;
  private readonly idempotencyTtlSeconds: number;
  private readonly terminalRetentionSeconds: number;

  constructor(options: RedisDesktopCommandQueueOptions) {
    if (!options?.client || typeof options.client.eval !== "function") {
      throw new Error("Redis desktop command queue requires a Redis eval client.");
    }
    const prefix = options.keyPrefix ?? "sofia:desktop:commands";
    if (!prefix.trim() || prefix.length > 128 || /[\\s{}]/.test(prefix)) throw new Error("Invalid Redis desktop command key prefix.");
    this.maxPayloadBytes = options.maxPayloadBytes ?? 65_536;
    this.maxCommandsPerDevice = options.maxCommandsPerDevice ?? 500;
    this.idempotencyTtlSeconds = options.idempotencyTtlSeconds ?? 86_400;
    this.terminalRetentionSeconds = options.terminalRetentionSeconds ?? 604_800;
    if (!Number.isSafeInteger(this.maxPayloadBytes) || this.maxPayloadBytes < 1_024 || this.maxPayloadBytes > 1_048_576) throw new Error("Invalid desktop command payload limit.");
    if (!Number.isSafeInteger(this.maxCommandsPerDevice) || this.maxCommandsPerDevice < 1 || this.maxCommandsPerDevice > 100_000) throw new Error("Invalid desktop command queue capacity.");
    if (!Number.isSafeInteger(this.idempotencyTtlSeconds) || this.idempotencyTtlSeconds < 60 || this.idempotencyTtlSeconds > 2_592_000) throw new Error("Invalid desktop command idempotency TTL.");
    if (!Number.isSafeInteger(this.terminalRetentionSeconds) || this.terminalRetentionSeconds < this.idempotencyTtlSeconds || this.terminalRetentionSeconds > 7_776_000) throw new Error("Invalid desktop command terminal retention period.");
    this.client = options.client;
    this.prefix = prefix;
  }

  async enqueue(input: EnqueueDesktopCommandInput): Promise<{ command: DesktopCommand; duplicate: boolean }> {
    validateOwnerDevice(input.ownerId, input.deviceId);
    if (typeof input.type !== "string" || !/^[a-z][a-z0-9._-]{1,95}$/.test(input.type)) throw new Error("Invalid desktop command type.");
    if (!input.input || typeof input.input !== "object" || Array.isArray(input.input)) throw new Error("Desktop command input must be an object.");
    const now = input.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid desktop command timestamp.");
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("Invalid desktop command maximum attempts.");
    if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 256)) {
      throw new Error("Invalid desktop command idempotency key.");
    }
    const id = input.id ?? randomUUID();
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new Error("Invalid desktop command ID.");
    const command: DesktopCommand = {
      id, ownerId: input.ownerId, deviceId: input.deviceId, type: input.type,
      input: input.input, status: "queued", createdAt: now, updatedAt: now,
      attempts: 0, maxAttempts,
    };
    const serialized = JSON.stringify(command);
    if (Buffer.byteLength(serialized, "utf8") > this.maxPayloadBytes) throw new Error("Desktop command payload too large.");
    const keys = this.keys(input.ownerId, input.deviceId);
    await this.pruneTerminal(input.ownerId, input.deviceId, now);
    const idemKey = input.idempotencyKey ? this.idempotencyRedisKey(keys.slot, input.idempotencyKey) : keys.idempotencyPlaceholder;
    const result = await this.client.eval(REDIS_DESKTOP_COMMAND_ENQUEUE_SCRIPT, {
      keys: [keys.pending, keys.leased, keys.records, idemKey],
      arguments: [id, serialized, String(now), String(this.maxCommandsPerDevice), input.idempotencyKey ? String(this.idempotencyTtlSeconds) : ""],
    });
    if (!Array.isArray(result) || typeof result[0] !== "string") throw new Error("Redis returned an invalid desktop command enqueue result.");
    if (result[0] === "full") throw new Error("Desktop command queue capacity reached.");
    if (result[0] === "id_conflict") throw new Error("Desktop command ID already exists.");
    if (result[0] === "duplicate" && typeof result[1] === "string") {
      const existing = await this.get(input.ownerId, input.deviceId, result[1]);
      if (!existing) throw new Error("Idempotent desktop command record is unavailable.");
      return { command: existing, duplicate: true };
    }
    if (result[0] !== "created") throw new Error("Redis rejected desktop command enqueue.");
    return { command, duplicate: false };
  }

  async claim(ownerId: string, deviceId: string, options: { now?: number; leaseMs?: number; leaseToken?: string } = {}): Promise<DesktopCommand | null> {
    validateOwnerDevice(ownerId, deviceId);
    const now = options.now ?? Date.now();
    const leaseMs = options.leaseMs ?? 30_000;
    const token = options.leaseToken ?? randomUUID();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) throw new Error("Invalid desktop command lease settings.");
    if (!/^[A-Za-z0-9-]{8,64}$/.test(token)) throw new Error("Invalid desktop command lease token.");
    const keys = this.keys(ownerId, deviceId);
    await this.pruneTerminal(ownerId, deviceId, now);
    const raw = await this.client.eval(REDIS_DESKTOP_COMMAND_CLAIM_SCRIPT, { keys: [keys.pending, keys.leased, keys.records, keys.terminal], arguments: [String(now), String(leaseMs), token] });
    if (raw === null || raw === undefined || raw === false) return null;
    return parseCommand(raw, ownerId, deviceId);
  }

  async complete(ownerId: string, deviceId: string, commandId: string, leaseToken: string, result: unknown, now = Date.now()): Promise<boolean> {
    validateCommandLease(ownerId, deviceId, commandId, leaseToken, now);
    const serialized = JSON.stringify(result ?? null);
    if (Buffer.byteLength(serialized, "utf8") > this.maxPayloadBytes) throw new Error("Desktop command result too large.");
    const keys = this.keys(ownerId, deviceId);
    return redisBoolean(await this.client.eval(REDIS_DESKTOP_COMMAND_COMPLETE_SCRIPT, { keys: [keys.leased, keys.records, keys.terminal], arguments: [commandId, leaseToken, String(now), serialized] }));
  }

  async fail(ownerId: string, deviceId: string, commandId: string, leaseToken: string, options: { now?: number; retryable?: boolean; retryDelayMs?: number; error: string }): Promise<boolean> {
    const now = options.now ?? Date.now();
    validateCommandLease(ownerId, deviceId, commandId, leaseToken, now);
    if (typeof options.error !== "string" || options.error.length === 0 || options.error.length > 2_000) throw new Error("Invalid desktop command failure detail.");
    const retryDelayMs = options.retryDelayMs ?? 1_000;
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 300_000) throw new Error("Invalid desktop command retry delay.");
    const keys = this.keys(ownerId, deviceId);
    return redisBoolean(await this.client.eval(REDIS_DESKTOP_COMMAND_FAIL_SCRIPT, { keys: [keys.pending, keys.leased, keys.records, keys.terminal], arguments: [commandId, leaseToken, String(now), options.retryable === true ? "1" : "0", options.error, String(retryDelayMs)] }));
  }

  async pruneTerminal(ownerId: string, deviceId: string, now = Date.now(), limit = 100): Promise<number> {
    validateOwnerDevice(ownerId, deviceId);
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Invalid desktop command retention prune settings.");
    const keys = this.keys(ownerId, deviceId);
    const cutoff = now - this.terminalRetentionSeconds * 1_000;
    const removed = await this.client.eval(REDIS_DESKTOP_COMMAND_PRUNE_TERMINAL_SCRIPT, { keys: [keys.records, keys.terminal], arguments: [String(cutoff), String(limit)] });
    if (typeof removed === "number" && Number.isSafeInteger(removed) && removed >= 0 && removed <= limit) return removed;
    if (typeof removed === "string" && /^\d+$/.test(removed) && Number(removed) <= limit) return Number(removed);
    throw new Error("Redis returned an invalid desktop command prune result.");
  }

  async get(ownerId: string, deviceId: string, commandId: string): Promise<DesktopCommand | null> {
    validateOwnerDevice(ownerId, deviceId);
    if (!/^[A-Za-z0-9-]{8,64}$/.test(commandId)) throw new Error("Invalid desktop command ID.");
    const keys = this.keys(ownerId, deviceId);
    const raw = await this.client.eval(REDIS_DESKTOP_COMMAND_GET_SCRIPT, { keys: [keys.records], arguments: [commandId] });
    if (raw === null || raw === undefined || raw === false) return null;
    return parseCommand(raw, ownerId, deviceId);
  }

  private keys(ownerId: string, deviceId: string) {
    const slot = `{owner-${createHash("sha256").update(ownerId).digest("hex")}-device-${createHash("sha256").update(deviceId).digest("hex")}}`;
    const base = `${this.prefix}:${slot}`;
    return { slot, pending: `${base}:pending`, leased: `${base}:leased`, records: `${base}:records`, terminal: `${base}:terminal`, idempotencyPlaceholder: `${base}:idempotency:none` };
  }

  private idempotencyRedisKey(slot: string, value: string): string {
    return `${this.prefix}:${slot}:idempotency:${createHash("sha256").update(value).digest("hex")}`;
  }
}

function validateOwnerDevice(ownerId: string, deviceId: string): void {
  if (typeof ownerId !== "string" || !ownerId.trim() || ownerId.length > 256) throw new Error("Invalid desktop command owner ID.");
  if (typeof deviceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(deviceId)) throw new Error("Invalid desktop command device ID.");
}

function validateCommandLease(ownerId: string, deviceId: string, commandId: string, leaseToken: string, now: number): void {
  validateOwnerDevice(ownerId, deviceId);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(commandId) || !/^[A-Za-z0-9-]{8,64}$/.test(leaseToken)) throw new Error("Invalid desktop command lease identity.");
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid desktop command timestamp.");
}

function parseCommand(raw: unknown, ownerId: string, deviceId: string): DesktopCommand {
  if (typeof raw !== "string" || raw.length > 1_100_000) throw new Error("Redis returned an invalid desktop command.");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Redis returned malformed desktop command data."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Redis returned an invalid desktop command.");
  const command = parsed as DesktopCommand;
  if (command.ownerId !== ownerId || command.deviceId !== deviceId ||
      !/^[A-Za-z0-9-]{8,64}$/.test(command.id) ||
      !["queued", "leased", "completed", "failed"].includes(command.status) ||
      !Number.isSafeInteger(command.createdAt) || !Number.isSafeInteger(command.updatedAt) ||
      !Number.isSafeInteger(command.attempts) || !Number.isSafeInteger(command.maxAttempts)) {
    throw new Error("Redis returned a desktop command outside the requested owner/device scope.");
  }
  return command;
}

function redisBoolean(value: unknown): boolean {
  if (value === 1 || value === 1n || value === "1") return true;
  if (value === 0 || value === 0n || value === "0") return false;
  throw new Error("Redis returned an invalid desktop command mutation result.");
}
