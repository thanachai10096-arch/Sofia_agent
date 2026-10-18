/**
 * Shared, atomic API usage accounting.
 *
 * Implementations must enforce consume() atomically across independent clients.
 * Do not fall back to process-local counters when shared accounting is configured.
 */
export interface UsageRecord {
  keyId: string;
  runs: number;
  toolCalls: number;
  startedAt: number;
}

export interface UsageStore {
  consume(keyId: string, toolCalls?: number): Promise<void>;
  get(keyId: string): Promise<UsageRecord>;
}

/** Minimal structural subset of node-postgres; avoids forcing a driver dependency. */
export interface SqlQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount?: number | null;
}

export interface SqlClient {
  query<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<SqlQueryResult<Row>>;
  release(): void;
}

export interface SqlPool {
  query<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<SqlQueryResult<Row>>;
  connect(): Promise<SqlClient>;
}

/**
 * PostgreSQL-backed shared usage counter.
 *
 * Call ensureSchema() during controlled startup/migration, before accepting API
 * traffic. Every consume is a short transaction that locks the per-key row, so
 * concurrent API replicas serialize quota decisions for that key.
 */
export class PostgresUsageStore implements UsageStore {
  constructor(
    private readonly pool: SqlPool,
    private readonly maxRunsPerKey = 100,
    private readonly maxToolCallsPerKey = 1000,
    private readonly windowMs = 86_400_000,
  ) {
    if (!Number.isSafeInteger(maxRunsPerKey) || maxRunsPerKey < 0) throw new Error("Invalid maxRunsPerKey quota.");
    if (!Number.isSafeInteger(maxToolCallsPerKey) || maxToolCallsPerKey < 0) throw new Error("Invalid maxToolCallsPerKey quota.");
    if (!Number.isSafeInteger(windowMs) || windowMs < 1_000) throw new Error("Invalid usage window.");
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sofia_api_usage (
        key_id TEXT PRIMARY KEY,
        runs BIGINT NOT NULL CHECK (runs >= 0),
        tool_calls BIGINT NOT NULL CHECK (tool_calls >= 0),
        started_at BIGINT NOT NULL
      )
    `);
  }

  async consume(keyId: string, toolCalls = 0): Promise<void> {
    if (!keyId || keyId.length > 256) throw new Error("Invalid usage key.");
    if (!Number.isSafeInteger(toolCalls) || toolCalls < 0) throw new Error("Invalid tool call usage amount.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const now = Date.now();
      await client.query(
        "INSERT INTO sofia_api_usage (key_id, runs, tool_calls, started_at) VALUES ($1, 0, 0, $2) ON CONFLICT (key_id) DO NOTHING",
        [keyId, now],
      );
      const selected = await client.query<{ runs: string | number; tool_calls: string | number; started_at: string | number }>(
        "SELECT runs, tool_calls, started_at FROM sofia_api_usage WHERE key_id = $1 FOR UPDATE",
        [keyId],
      );
      const row = selected.rows[0];
      if (!row) throw new Error("Shared usage record unavailable.");
      let runs = Number(row.runs);
      let currentToolCalls = Number(row.tool_calls);
      let startedAt = Number(row.started_at);
      if (![runs, currentToolCalls, startedAt].every(Number.isSafeInteger) || runs < 0 || currentToolCalls < 0 || startedAt < 0) {
        throw new Error("Invalid shared usage record.");
      }
      if (now - startedAt >= this.windowMs) {
        runs = 0;
        currentToolCalls = 0;
        startedAt = now;
      }
      if (runs >= this.maxRunsPerKey || currentToolCalls + toolCalls > this.maxToolCallsPerKey) {
        throw new Error("API usage quota exceeded.");
      }
      await client.query(
        "UPDATE sofia_api_usage SET runs = $2, tool_calls = $3, started_at = $4 WHERE key_id = $1",
        [keyId, runs + 1, currentToolCalls + toolCalls, startedAt],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async get(keyId: string): Promise<UsageRecord> {
    const result = await this.pool.query<{ runs: string | number; tool_calls: string | number; started_at: string | number }>(
      "SELECT runs, tool_calls, started_at FROM sofia_api_usage WHERE key_id = $1",
      [keyId],
    );
    const row = result.rows[0];
    if (!row) return { keyId, runs: 0, toolCalls: 0, startedAt: Date.now() };
    const runs = Number(row.runs);
    const toolCalls = Number(row.tool_calls);
    const startedAt = Number(row.started_at);
    if (![runs, toolCalls, startedAt].every(Number.isSafeInteger) || runs < 0 || toolCalls < 0 || startedAt < 0) {
      throw new Error("Invalid shared usage record.");
    }
    if (Date.now() - startedAt >= this.windowMs) return { keyId, runs: 0, toolCalls: 0, startedAt: Date.now() };
    return { keyId, runs, toolCalls, startedAt };
  }
}
