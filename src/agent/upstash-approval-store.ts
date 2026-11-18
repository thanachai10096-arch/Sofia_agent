import { createHash } from "node:crypto";
import type { ApprovalDecision, ApprovalDecisionStore, ApprovalRecord } from "./approval-broker.js";

interface UpstashRestResponse {
  result?: unknown;
  error?: string;
}

export const APPROVAL_CREATE_SCRIPT = `
local created = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])
if not created then return 0 end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
redis.call('PEXPIRE', KEYS[2], ARGV[5])
return 1
`;

export const APPROVAL_RESOLVE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local record = cjson.decode(raw)
if record.status ~= 'pending' or record.actionHash ~= ARGV[1] then return 0 end
local now = tonumber(ARGV[3])
if tonumber(record.expiresAt) <= now then
  record.status = 'expired'
  record.resolvedAt = now
  record.resolvedBy = 'system:expiry'
  redis.call('SET', KEYS[1], cjson.encode(record), 'PX', ARGV[4])
  redis.call('ZREM', KEYS[2], ARGV[2])
  if ARGV[5] == 'expired' then return 1 else return 0 end
end
if ARGV[5] == 'expired' then return 0 end
record.status = ARGV[5]
record.resolvedAt = now
record.resolvedBy = ARGV[6]
redis.call('SET', KEYS[1], cjson.encode(record), 'PX', ARGV[4])
redis.call('ZREM', KEYS[2], ARGV[2])
return 1
`;

/**
 * Shared approval store using Upstash Redis REST. Lua scripts make create and
 * pending-only decisions atomic across application replicas. All script keys
 * share one Redis Cluster hash tag.
 */
export class UpstashApprovalDecisionStore implements ApprovalDecisionStore {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly prefix: string;
  private readonly retentionMs: number;

  constructor(options: {
    url: string;
    token: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    prefix?: string;
    retentionMs?: number;
  }) {
    let parsed: URL;
    try { parsed = new URL(options.url); }
    catch { throw new Error("Approval Redis REST URL is invalid."); }
    const localHttp = parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if ((parsed.protocol !== "https:" && !localHttp) ||
        parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("Approval Redis REST URL must use HTTPS without embedded credentials or query parameters.");
    }
    const token = options.token.trim();
    if (!token || token.length > 4096) throw new Error("Approval Redis REST token is invalid.");
    const timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30_000) {
      throw new Error("Approval Redis REST timeout must be between 500 and 30000 milliseconds.");
    }
    const prefix = options.prefix ?? "sofia";
    if (!/^[a-zA-Z0-9:_-]{1,64}$/u.test(prefix)) throw new Error("Approval Redis key prefix is invalid.");
    const retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60_000;
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 60_000 || retentionMs > 30 * 24 * 60 * 60_000) {
      throw new Error("Approval Redis retention must be between one minute and 30 days.");
    }
    this.endpoint = parsed.origin + parsed.pathname.replace(/\/+$/u, "");
    this.token = token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = timeoutMs;
    this.prefix = prefix;
    this.retentionMs = retentionMs;
  }

  private recordKey(id: string): string {
    if (!/^[a-zA-Z0-9:_-]{1,128}$/u.test(id)) throw new Error("Approval ID is invalid.");
    return this.prefix + ":{approvals}:record:" + id;
  }

  private ownerIndexKey(principalId: string): string {
    if (!principalId.trim() || principalId.length > 256) throw new Error("Approval principal is invalid.");
    const ownerHash = createHash("sha256").update(principalId).digest("hex");
    return this.prefix + ":{approvals}:owner:" + ownerHash;
  }

  private async command(command: Array<string | number>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authorization: "Bearer " + this.token,
          "content-type": "application/json",
        },
        body: JSON.stringify(command),
        signal: controller.signal,
      });
      let payload: UpstashRestResponse;
      try { payload = await response.json() as UpstashRestResponse; }
      catch { throw new Error("Approval Redis REST response was not valid JSON."); }
      if (!response.ok || typeof payload.error === "string") throw new Error("Approval Redis command failed.");
      return payload.result;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Approval Redis")) throw error;
      throw new Error("Approval Redis request failed.");
    } finally {
      clearTimeout(timer);
    }
  }

  private async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    return this.command(["EVAL", script, keys.length, ...keys, ...args]);
  }

  async create(record: ApprovalRecord): Promise<void> {
    const recordTtl = Math.max(1, record.expiresAt - Date.now()) + this.retentionMs;
    const indexTtl = 30 * 24 * 60 * 60_000;
    const result = await this.eval(
      APPROVAL_CREATE_SCRIPT,
      [this.recordKey(record.id), this.ownerIndexKey(record.principalId)],
      [JSON.stringify(record), String(recordTtl), String(record.createdAt), record.id, String(indexTtl)],
    );
    if (Number(result) !== 1) throw new Error("Approval request already exists.");
  }

  async get(id: string): Promise<ApprovalRecord | undefined> {
    const raw = await this.command(["GET", this.recordKey(id)]);
    if (raw === null || raw === undefined) return undefined;
    if (typeof raw !== "string") throw new Error("Stored approval record is invalid.");
    return parseRecord(raw);
  }

  async listPending(principalId: string): Promise<ApprovalRecord[]> {
    const indexKey = this.ownerIndexKey(principalId);
    const idsRaw = await this.command(["ZRANGE", indexKey, 0, 199]);
    if (!Array.isArray(idsRaw)) throw new Error("Approval Redis index response is invalid.");
    const ids = idsRaw.filter((id): id is string => typeof id === "string" && /^[a-zA-Z0-9:_-]{1,128}$/u.test(id));
    if (ids.length === 0) return [];
    const values = await this.command(["MGET", ...ids.map((id) => this.recordKey(id))]);
    if (!Array.isArray(values) || values.length !== ids.length) throw new Error("Approval Redis records response is invalid.");
    const now = Date.now();
    const approvals: ApprovalRecord[] = [];
    const stale: string[] = [];
    for (let i = 0; i < ids.length; i += 1) {
      const raw = values[i];
      if (typeof raw !== "string") { stale.push(ids[i]!); continue; }
      const record = parseRecord(raw);
      if (record.principalId !== principalId || record.status !== "pending") { stale.push(ids[i]!); continue; }
      if (record.expiresAt <= now) {
        await this.resolve(record.id, record.actionHash, "expired", "system:expiry", now);
        continue;
      }
      approvals.push(record);
    }
    if (stale.length) await this.command(["ZREM", indexKey, ...stale]);
    return approvals;
  }

  async resolve(
    id: string,
    actionHash: string,
    decision: ApprovalDecision,
    resolvedBy: string,
    now: number,
  ): Promise<boolean> {
    const record = await this.get(id);
    if (!record) return false;
    const result = await this.eval(
      APPROVAL_RESOLVE_SCRIPT,
      [this.recordKey(id), this.ownerIndexKey(record.principalId)],
      [actionHash, id, String(now), String(this.retentionMs), decision, resolvedBy],
    );
    return Number(result) === 1;
  }
}

function parseRecord(raw: string): ApprovalRecord {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Stored approval record is invalid."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored approval record is invalid.");
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.runId !== "string" ||
      typeof record.principalId !== "string" || typeof record.toolName !== "string" ||
      typeof record.actionHash !== "string" || typeof record.createdAt !== "number" ||
      typeof record.expiresAt !== "number" || typeof record.status !== "string" ||
      !["pending", "approved", "denied", "expired", "cancelled"].includes(record.status) ||
      !record.input || typeof record.input !== "object" || Array.isArray(record.input)) {
    throw new Error("Stored approval record is invalid.");
  }
  return record as unknown as ApprovalRecord;
}
