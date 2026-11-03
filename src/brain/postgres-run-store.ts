import type { BrainRunSnapshot } from "./run-state.js";
import type { RunStore } from "./run-store.js";
import type { PostgresExecutor } from "./postgres-job-state-store.js";

/** PostgreSQL-backed run snapshots so a different worker can resume a job. */
export class PostgresRunStore implements RunStore {
  constructor(private readonly db: PostgresExecutor) {}

  async save(snapshot: BrainRunSnapshot): Promise<void> {
    await this.db.query(
      `INSERT INTO sofia_agent_run_snapshots (run_id,snapshot,updated_at)
       VALUES ($1,$2::jsonb,now())
       ON CONFLICT (run_id) DO UPDATE SET snapshot=EXCLUDED.snapshot,updated_at=now()`,
      [snapshot.runId,JSON.stringify(snapshot)],
    );
  }

  async load(runId: string): Promise<BrainRunSnapshot | undefined> {
    const result = await this.db.query<{ snapshot: BrainRunSnapshot | string }>(
      `SELECT snapshot FROM sofia_agent_run_snapshots WHERE run_id=$1 LIMIT 1`,
      [runId],
    );
    const value = result.rows[0]?.snapshot;
    if (value === undefined) return undefined;
    if (typeof value !== "string") return value;
    try { return JSON.parse(value) as BrainRunSnapshot; } catch { return undefined; }
  }

  async delete(runId: string): Promise<void> {
    await this.db.query(`DELETE FROM sofia_agent_run_snapshots WHERE run_id=$1`,[runId]);
  }
}
