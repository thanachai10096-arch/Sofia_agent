import type { AutonomyPgPool } from "./postgres-job-store.js";
import type { SkillRegistryState, SkillRegistryStore } from "./skill-registry.js";

interface QueryResult<Row> { rows: Row[]; rowCount?: number | null }
interface TransactionClient {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>;
  release(): void;
}

/**
 * PostgreSQL-backed registry state. A row lock serializes all registry
 * mutations within a project scope; callers must pass only a trusted server
 * pool and host-resolved scope identifiers.
 */
export class PostgresSkillRegistryStore implements SkillRegistryStore {
  constructor(private readonly pool: AutonomyPgPool, private readonly table = "sofia_skill_registry") {
    if (!/^[a-z_][a-z0-9_]*$/.test(table) || table.length > 32) {
      throw new Error("Invalid skill registry table identifier.");
    }
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
      scope_id text PRIMARY KEY CHECK (length(scope_id) BETWEEN 1 AND 512),
      state jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  }

  async transact<T>(scope: string, operation: (state: SkillRegistryState) => Promise<T> | T): Promise<T> {
    if (typeof scope !== "string" || !scope.trim() || scope.length > 512) {
      throw new Error("A host-resolved registry scope is required.");
    }
    const client = await this.pool.connect() as TransactionClient;
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ${this.table} (scope_id, state) VALUES ($1, $2::jsonb)
         ON CONFLICT (scope_id) DO NOTHING`,
        [scope, JSON.stringify({ versions: {}, active: {}, audit: [] })],
      );
      const selected = await client.query<{ state: SkillRegistryState }>(
        `SELECT state FROM ${this.table} WHERE scope_id=$1 FOR UPDATE`,
        [scope],
      );
      const row = selected.rows[0];
      if (!row || !row.state || typeof row.state !== "object") {
        throw new Error("Skill registry state is missing or malformed.");
      }
      const state = row.state;
      if (!state.versions || typeof state.versions !== "object" ||
          !state.active || typeof state.active !== "object" || !Array.isArray(state.audit)) {
        throw new Error("Skill registry state failed structural validation.");
      }
      const result = await operation(state);
      const serialized = JSON.stringify(state);
      if (Buffer.byteLength(serialized, "utf8") > 8 * 1024 * 1024) {
        throw new Error("Skill registry state exceeds 8 MiB.");
      }
      await client.query(
        `UPDATE ${this.table} SET state=$2::jsonb, updated_at=now() WHERE scope_id=$1`,
        [scope, serialized],
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
