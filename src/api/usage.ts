export interface UsageRecord {
  keyId: string;
  runs: number;
  toolCalls: number;
  startedAt: number;
}

const WINDOW_MS = 24 * 60 * 60 * 1000;

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

  private currentRecord(keyId: string, now = Date.now()): UsageRecord {
    const current = this.records.get(keyId);
    if (!current) {
      const created = { keyId, runs: 0, toolCalls: 0, startedAt: now };
      this.records.set(keyId, created);
      return created;
    }
    if (now - current.startedAt >= WINDOW_MS) {
      current.runs = 0;
      current.toolCalls = 0;
      current.startedAt = now;
    }
    return current;
  }

  consume(keyId: string, toolCalls = 0): void {
    if (!Number.isSafeInteger(toolCalls) || toolCalls < 0) {
      throw new Error("Invalid tool call usage amount.");
    }
    const current = this.currentRecord(keyId);
    if (current.runs >= this.maxRunsPerKey || current.toolCalls + toolCalls > this.maxToolCallsPerKey) {
      throw new Error("API usage quota exceeded.");
    }
    current.runs += 1;
    current.toolCalls += toolCalls;
  }

  /** Reserve one actual tool-call attempt without incrementing the run count. */
  consumeToolCall(keyId: string, amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error("Invalid tool call usage amount.");
    }
    const current = this.currentRecord(keyId);
    if (current.toolCalls + amount > this.maxToolCallsPerKey) {
      throw new Error("API usage quota exceeded.");
    }
    current.toolCalls += amount;
  }

  get(keyId: string): UsageRecord {
    const current = this.records.get(keyId);
    // Do not expose mutable internal counters to API consumers.
    return current
      ? { ...current }
      : { keyId, runs: 0, toolCalls: 0, startedAt: Date.now() };
  }
}
