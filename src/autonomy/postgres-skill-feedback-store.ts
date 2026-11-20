import type { AutonomyPgPool } from "./postgres-job-store.js";
import type { SkillFeedbackState, SkillFeedbackStore } from "./skill-feedback.js";

interface QueryResult<Row> { rows: Row[]; rowCount?: number | null }
interface TransactionClient {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>;
  release(): void;
}

/** Durable tenant-scoped feedback store using one serializable row per scope. */
export class PostgresSkillFeedbackStore implements SkillFeedbackStore {
  constructor(private readonly pool: AutonomyPgPool, private readonly table = "sofia_skill_feedback") {
    if (!/^[a-z_][a-z0-9_]*$/.test(table) || table.length > 32) {
      throw new Error("Invalid skill feedback table identifier.");
    }
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
      scope_id text PRIMARY KEY CHECK (length(scope_id) BETWEEN 1 AND 512),
      state jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  }

  async transact<T>(scope: string, operation: (state: SkillFeedbackState) => T | Promise<T>): Promise<T> {
    if (typeof scope !== "string" || !scope.trim() || scope.length > 512) {
      throw new Error("A host-resolved feedback scope is required.");
    }
    const client = await this.pool.connect() as TransactionClient;
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ${this.table} (scope_id, state) VALUES ($1, $2::jsonb)
         ON CONFLICT (scope_id) DO NOTHING`,
        [scope, JSON.stringify({ entries: [], idempotency: {} })],
      );
      const selected = await client.query<{ state: SkillFeedbackState }>(
        `SELECT state FROM ${this.table} WHERE scope_id=$1 FOR UPDATE`,
        [scope],
      );
      const state = selected.rows[0]?.state;
      if (!state || typeof state !== "object" || !Array.isArray(state.entries) ||
          !state.idempotency || typeof state.idempotency !== "object" || Array.isArray(state.idempotency)) {
        throw new Error("Skill feedback state failed structural validation.");
      }
      const result = await operation(state);
      const serialized = JSON.stringify(state);
      if (Buffer.byteLength(serialized, "utf8") > 16 * 1024 * 1024) {
        throw new Error("Skill feedback state exceeds 16 MiB; apply retention or archival.");
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
