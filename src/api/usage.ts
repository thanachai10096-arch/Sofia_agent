import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface UsageRecord { keyId: string; runs: number; toolCalls: number; startedAt: number; }
export interface UsageStore {
  loadAllSync(): UsageRecord[];
  saveSync(record: UsageRecord): void;
}

/** Local, single-process persistence. Use a transactional shared adapter for multi-worker deployments. */
export class FileUsageStore implements UsageStore {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { chmodSync(directory, 0o700); } catch { /* permissions are platform-dependent */ }
  }

  loadAllSync(): UsageRecord[] {
    let names: string[];
    try { names = readdirSync(this.directory); } catch { return []; }
    const records: UsageRecord[] = [];
    for (const name of names) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
      try {
        const value: unknown = JSON.parse(readFileSync(path.join(this.directory, name), "utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const record = value as Partial<UsageRecord>;
        if (record.keyId !== name.slice(0, -5) ||
            !Number.isSafeInteger(record.runs) || (record.runs ?? -1) < 0 ||
            !Number.isSafeInteger(record.toolCalls) || (record.toolCalls ?? -1) < 0 ||
            !Number.isSafeInteger(record.startedAt) || (record.startedAt ?? -1) < 0) continue;
        records.push(record as UsageRecord);
      } catch { /* ignore malformed records; do not trust file contents */ }
    }
    return records;
  }

  saveSync(record: UsageRecord): void {
    if (!/^[a-f0-9]{32}$/.test(record.keyId)) throw new Error("Invalid usage-store key ID.");
    const target = path.join(this.directory, record.keyId + ".json");
    const temporary = target + "." + process.pid + ".tmp";
    writeFileSync(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* permissions are platform-dependent */ }
    renameSync(temporary, target);
  }
}

export class UsageLimiter {
  private readonly records = new Map<string, UsageRecord>();

  constructor(
    private readonly maxRunsPerKey = 100,
    private readonly maxToolCallsPerKey = 1000,
    private readonly store?: UsageStore,
  ) {
    if (!Number.isSafeInteger(maxRunsPerKey) || maxRunsPerKey < 0) throw new Error("Invalid maxRunsPerKey quota.");
    if (!Number.isSafeInteger(maxToolCallsPerKey) || maxToolCallsPerKey < 0) throw new Error("Invalid maxToolCallsPerKey quota.");
    for (const record of store?.loadAllSync() ?? []) {
      if (/^[a-f0-9]{32}$/.test(record.keyId)) this.records.set(record.keyId, { ...record });
    }
  }

  consume(keyId: string, toolCalls = 0): void {
    if (!Number.isSafeInteger(toolCalls) || toolCalls < 0) throw new Error("Invalid tool call usage amount.");
    const now = Date.now();
    const previous = this.records.get(keyId);
    const current: UsageRecord = previous ? { ...previous } : { keyId, runs: 0, toolCalls: 0, startedAt: now };
    if (now - current.startedAt >= 86_400_000) {
      current.runs = 0;
      current.toolCalls = 0;
      current.startedAt = now;
    }
    if (current.runs >= this.maxRunsPerKey || current.toolCalls + toolCalls > this.maxToolCallsPerKey) {
      throw new Error("API usage quota exceeded.");
    }
    current.runs += 1;
    current.toolCalls += toolCalls;
    // Persist before accepting the usage increment; storage errors fail closed.
    this.store?.saveSync(current);
    this.records.set(keyId, current);
  }

  /** Reserve a tool call before execution; false means the configured cap was reached. */
  recordToolCalls(keyId: string, amount = 1): boolean {
    if (!Number.isSafeInteger(amount) || amount < 1) throw new Error("Invalid tool call usage amount.");
    const now = Date.now();
    const previous = this.records.get(keyId);
    const current: UsageRecord = previous ? { ...previous } : { keyId, runs: 0, toolCalls: 0, startedAt: now };
    if (now - current.startedAt >= 86_400_000) {
      current.runs = 0;
      current.toolCalls = 0;
      current.startedAt = now;
    }
    if (current.toolCalls + amount > this.maxToolCallsPerKey) return false;
    current.toolCalls += amount;
    this.store?.saveSync(current);
    this.records.set(keyId, current);
    return true;
  }

  get(keyId: string): UsageRecord {
    const record = this.records.get(keyId);
    return record ? { ...record } : { keyId, runs: 0, toolCalls: 0, startedAt: Date.now() };
  }
}
