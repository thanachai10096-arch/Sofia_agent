import { closeSync, chmodSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

export interface UsageRecord {
  keyId: string;
  runs: number;
  toolCalls: number;
  startedAt: number;
  /** Successful Brain runs with provider-reported token accounting. */
  brainRuns?: number;
  /** Model calls reported by Brain; excludes legacy runs without structured usage. */
  brainModelCalls?: number;
  /** Brain reserved-or-used tokens; not guaranteed to equal provider-billed tokens. */
  brainReservedOrUsedTokens?: number;
  /** Tokens reported by model providers, excluding estimates/reservations. */
  providerInputTokens?: number;
  providerOutputTokens?: number;
  providerUsageCalls?: number;
  /** Configured route-price estimate in nano-USD; not provider-billed cost. */
  configuredCostNanoUsd?: string;
}

const WINDOW_MS = 24 * 60 * 60 * 1000;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 120_000;

function validRecord(value: unknown): value is UsageRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<UsageRecord>;
  return typeof record.keyId === "string" &&
    Number.isSafeInteger(record.runs) && (record.runs ?? -1) >= 0 &&
    Number.isSafeInteger(record.toolCalls) && (record.toolCalls ?? -1) >= 0 &&
    Number.isSafeInteger(record.startedAt) && (record.startedAt ?? -1) >= 0 &&
    (record.brainRuns === undefined || (Number.isSafeInteger(record.brainRuns) && record.brainRuns >= 0)) &&
    (record.brainModelCalls === undefined || (Number.isSafeInteger(record.brainModelCalls) && record.brainModelCalls >= 0)) &&
    (record.brainReservedOrUsedTokens === undefined || (Number.isSafeInteger(record.brainReservedOrUsedTokens) && record.brainReservedOrUsedTokens >= 0)) &&
    (record.providerInputTokens === undefined || (Number.isSafeInteger(record.providerInputTokens) && record.providerInputTokens >= 0)) &&
    (record.providerOutputTokens === undefined || (Number.isSafeInteger(record.providerOutputTokens) && record.providerOutputTokens >= 0)) &&
    (record.providerUsageCalls === undefined || (Number.isSafeInteger(record.providerUsageCalls) && record.providerUsageCalls >= 0)) &&
    (record.configuredCostNanoUsd === undefined || (typeof record.configuredCostNanoUsd === "string" && /^(0|[1-9][0-9]*)$/.test(record.configuredCostNanoUsd)));
}

/**
 * Per-key usage accounting. When storagePath is supplied, each operation reloads
 * and updates the file under an exclusive lock, preserving counters across restarts
 * and coordinating processes that share a filesystem with atomic exclusive-create.
 */
export class UsageLimiter {
  private readonly records = new Map<string, UsageRecord>();
  private readonly storagePath?: string;
  private readonly lockPath?: string;

  constructor(
    private readonly maxRunsPerKey = 100,
    private readonly maxToolCallsPerKey = 1000,
    storagePath?: string,
  ) {
    if (!Number.isSafeInteger(maxRunsPerKey) || maxRunsPerKey < 0) throw new Error("Invalid maxRunsPerKey quota.");
    if (!Number.isSafeInteger(maxToolCallsPerKey) || maxToolCallsPerKey < 0) throw new Error("Invalid maxToolCallsPerKey quota.");
    if (storagePath) {
      this.storagePath = path.resolve(storagePath);
      this.lockPath = this.storagePath + ".lock";
      mkdirSync(path.dirname(this.storagePath), { recursive: true, mode: 0o700 });
      try { chmodSync(path.dirname(this.storagePath), 0o700); } catch { /* platform may not support chmod */ }
      this.withLock(() => { this.readPersistentRecords(); });
    }
  }

  private withLock<T>(operation: () => T): T {
    if (!this.lockPath) return operation();
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    const token = randomUUID();
    while (true) {
      try {
        const fd = openSync(this.lockPath, "wx", 0o600);
        try {
          writeFileSync(fd, JSON.stringify({ token, pid: process.pid, hostname: os.hostname(), createdAt: Date.now() }), "utf8");
        } finally {
          closeSync(fd);
        }
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        try {
          const lock = JSON.parse(readFileSync(this.lockPath, "utf8")) as { pid?: unknown; hostname?: unknown; createdAt?: unknown };
          if (typeof lock.createdAt === "number" && Date.now() - lock.createdAt > STALE_LOCK_MS) {
            // Avoid unlink races between multiple reclaimers. Stale locks require explicit operator review.
            throw new Error("Usage quota lock is stale; refusing unsafe automatic recovery.");
          }
          if (lock.hostname === os.hostname() && Number.isSafeInteger(lock.pid) && Number(lock.pid) > 0) {
            try { process.kill(Number(lock.pid), 0); }
            catch (probeError) {
              if ((probeError as NodeJS.ErrnoException).code === "ESRCH") {
                throw new Error("Usage quota lock owner is no longer running; remove the stale lock after verifying no writer is active.");
              }
            }
          }
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
          if (readError instanceof SyntaxError) {
            // Another process may have created the lock but not finished writing its owner record.
            if (Date.now() < deadline) {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
              continue;
            }
            throw new Error("Timed out waiting for a valid shared usage quota lock.");
          }
          throw readError;
        }
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the shared usage quota lock.");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try { return operation(); }
    finally {
      try {
        const lock = JSON.parse(readFileSync(this.lockPath, "utf8")) as { token?: unknown };
        if (lock.token === token) rmSync(this.lockPath, { force: true });
      } catch { /* fail closed on next operation if lock ownership cannot be confirmed */ }
    }
  }

  private readPersistentRecords(): void {
    this.records.clear();
    if (!this.storagePath || !existsSync(this.storagePath)) return;
    const parsed: unknown = JSON.parse(readFileSync(this.storagePath, "utf8"));
    if (!Array.isArray(parsed) || !parsed.every(validRecord)) {
      throw new Error("Usage quota store is invalid; refusing to reset counters.");
    }
    for (const record of parsed) {
      // Preserve legacy persisted record shapes; Brain counters are added only when Brain usage is recorded.
      this.records.set(record.keyId, { ...record });
    }
  }

  private persistRecords(): void {
    if (!this.storagePath) return;
    const tempPath = this.storagePath + "." + process.pid + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(tempPath, JSON.stringify([...this.records.values()]), { encoding: "utf8", mode: 0o600 });
      try { chmodSync(tempPath, 0o600); } catch { /* platform may not support chmod */ }
      renameSync(tempPath, this.storagePath);
    } finally {
      try { rmSync(tempPath, { force: true }); } catch { /* already renamed */ }
    }
  }

  private transaction<T>(operation: () => T, persist: boolean): T {
    if (!this.storagePath) return operation();
    return this.withLock(() => {
      this.readPersistentRecords();
      const result = operation();
      if (persist) this.persistRecords();
      return result;
    });
  }

  private currentRecord(keyId: string, now = Date.now()): UsageRecord {
    const current = this.records.get(keyId);
    if (!current) {
      const created: UsageRecord = { keyId, runs: 0, toolCalls: 0, startedAt: now };
      this.records.set(keyId, created);
      return created;
    }
    if (now - current.startedAt >= WINDOW_MS) {
      current.runs = 0;
      current.toolCalls = 0;
      current.startedAt = now;
      if (current.brainRuns !== undefined) current.brainRuns = 0;
      if (current.brainModelCalls !== undefined) current.brainModelCalls = 0;
      if (current.brainReservedOrUsedTokens !== undefined) current.brainReservedOrUsedTokens = 0;
      if (current.providerInputTokens !== undefined) current.providerInputTokens = 0;
      if (current.providerOutputTokens !== undefined) current.providerOutputTokens = 0;
      if (current.providerUsageCalls !== undefined) current.providerUsageCalls = 0;
      if (current.configuredCostNanoUsd !== undefined) current.configuredCostNanoUsd = "0";
    }
    return current;
  }

  consume(keyId: string, toolCalls = 0): void {
    if (!Number.isSafeInteger(toolCalls) || toolCalls < 0) throw new Error("Invalid tool call usage amount.");
    this.transaction(() => {
      const current = this.currentRecord(keyId);
      if (current.runs >= this.maxRunsPerKey || current.toolCalls + toolCalls > this.maxToolCallsPerKey) throw new Error("API usage quota exceeded.");
      current.runs += 1;
      current.toolCalls += toolCalls;
    }, true);
  }

  consumeToolCall(keyId: string, amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Invalid tool call usage amount.");
    this.transaction(() => {
      const current = this.currentRecord(keyId);
      if (current.toolCalls + amount > this.maxToolCallsPerKey) throw new Error("API usage quota exceeded.");
      current.toolCalls += amount;
    }, true);
  }

  /** Record aggregate Brain usage only when a completed report contains valid counters. */
  recordBrainUsage(keyId: string, usage: { modelCalls: number; reservedOrUsedTokens: number; providerInputTokens?: number; providerOutputTokens?: number; providerUsageCalls?: number; configuredCostNanoUsd?: string }): void {
    if (!Number.isSafeInteger(usage.modelCalls) || usage.modelCalls < 0 ||
        !Number.isSafeInteger(usage.reservedOrUsedTokens) || usage.reservedOrUsedTokens < 0) {
      throw new Error("Invalid Brain usage metrics.");
    }
    const providerValues = [usage.providerInputTokens, usage.providerOutputTokens, usage.providerUsageCalls];
    if (providerValues.some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0)) ||
        ((usage.providerInputTokens === undefined) !== (usage.providerOutputTokens === undefined)) ||
        (usage.providerUsageCalls !== undefined && usage.providerInputTokens === undefined) ||
        (usage.configuredCostNanoUsd !== undefined && (typeof usage.configuredCostNanoUsd !== "string" || !/^(0|[1-9][0-9]*)$/.test(usage.configuredCostNanoUsd)))) {
      throw new Error("Invalid provider-reported token metrics.");
    }
    this.transaction(() => {
      const current = this.currentRecord(keyId);
      // Validate every prospective total before mutating any field. Without this,
      // individually valid provider reports could overflow the persisted safe-integer
      // counters and make the ledger unreadable after a restart.
      const next = {
        brainRuns: (current.brainRuns ?? 0) + 1,
        brainModelCalls: (current.brainModelCalls ?? 0) + usage.modelCalls,
        brainReservedOrUsedTokens: (current.brainReservedOrUsedTokens ?? 0) + usage.reservedOrUsedTokens,
        providerInputTokens: usage.providerInputTokens === undefined
          ? current.providerInputTokens
          : (current.providerInputTokens ?? 0) + usage.providerInputTokens,
        providerOutputTokens: usage.providerOutputTokens === undefined
          ? current.providerOutputTokens
          : (current.providerOutputTokens ?? 0) + usage.providerOutputTokens,
        providerUsageCalls: usage.providerInputTokens === undefined
          ? current.providerUsageCalls
          : (current.providerUsageCalls ?? 0) + (usage.providerUsageCalls ?? 0),
        configuredCostNanoUsd: usage.configuredCostNanoUsd === undefined
          ? current.configuredCostNanoUsd
          : (BigInt(current.configuredCostNanoUsd ?? "0") + BigInt(usage.configuredCostNanoUsd)).toString(),
      };
      if (Object.values(next).some((value) => value !== undefined && !Number.isSafeInteger(value))) {
        throw new Error("Aggregated usage metrics exceed the safe integer range.");
      }
      current.brainRuns = next.brainRuns;
      current.brainModelCalls = next.brainModelCalls;
      current.brainReservedOrUsedTokens = next.brainReservedOrUsedTokens;
      if (next.providerInputTokens !== undefined) current.providerInputTokens = next.providerInputTokens;
      if (next.providerOutputTokens !== undefined) current.providerOutputTokens = next.providerOutputTokens;
      if (next.providerUsageCalls !== undefined) current.providerUsageCalls = next.providerUsageCalls;
      if (next.configuredCostNanoUsd !== undefined) current.configuredCostNanoUsd = next.configuredCostNanoUsd;
    }, true);
  }

  get(keyId: string): UsageRecord {
    return this.transaction(() => {
      const current = this.records.get(keyId);
      return current
        ? {
            ...current,
            brainRuns: current.brainRuns ?? 0,
            brainModelCalls: current.brainModelCalls ?? 0,
            brainReservedOrUsedTokens: current.brainReservedOrUsedTokens ?? 0,
          }
        : {
            keyId, runs: 0, toolCalls: 0, startedAt: Date.now(),
            brainRuns: 0, brainModelCalls: 0, brainReservedOrUsedTokens: 0,
          };
    }, false);
  }
}
