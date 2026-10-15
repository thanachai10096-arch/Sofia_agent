export interface UsageRecord {
  keyId: string;
  runs: number;
  toolCalls: number;
  startedAt: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Process-local rolling-window usage counters for the API server. */
export class UsageLimiter {
  private readonly records = new Map<string, UsageRecord>();

  constructor(
    private readonly maxRunsPerKey = 100,
    private readonly maxToolCallsPerKey = 1000,
  ) {
    if (!Number.isSafeInteger(maxRunsPerKey) || maxRunsPerKey < 0) {
      throw new Error("Invalid maxRunsPerKey quota.");
    }
    if (!Number.isSafeInteger(maxToolCallsPerKey) || maxToolCallsPerKey < 0) {
      throw new Error("Invalid maxToolCallsPerKey quota.");
    }
  }

  private current(keyId: string, now = Date.now()): UsageRecord {
    if (typeof keyId !== "string" || keyId.length === 0) {
      throw new Error("Invalid API usage key.");
    }
    const record = this.records.get(keyId) ?? {
      keyId,
      runs: 0,
      toolCalls: 0,
      startedAt: now,
    };
    if (now - record.startedAt >= DAY_MS) {
      record.runs = 0;
      record.toolCalls = 0;
      record.startedAt = now;
    }
    this.records.set(keyId, record);
    return record;
  }

  /** Reserve one run. Kept compatible with existing API call sites. */
  consume(keyId: string, toolCalls = 0): void {
    if (!Number.isSafeInteger(toolCalls) || toolCalls < 0) {
      throw new Error("Invalid tool call usage amount.");
    }
    const record = this.current(keyId);
    if (record.runs >= this.maxRunsPerKey || record.toolCalls + toolCalls > this.maxToolCallsPerKey) {
      throw new Error("API usage quota exceeded.");
    }
    record.runs += 1;
    record.toolCalls += toolCalls;
  }

  /**
   * Record a tool call immediately before execution. Returns false at the cap,
   * allowing the caller to abort the run before the tool's execute() is invoked.
   */
  recordToolCalls(keyId: string, amount = 1): boolean {
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new Error("Invalid tool call usage amount.");
    }
    const record = this.current(keyId);
    if (record.toolCalls + amount > this.maxToolCallsPerKey) return false;
    record.toolCalls += amount;
    return true;
  }

  get(keyId: string): UsageRecord {
    const record = this.records.get(keyId);
    if (!record) return { keyId, runs: 0, toolCalls: 0, startedAt: Date.now() };
    return { ...this.current(keyId) };
  }
}
