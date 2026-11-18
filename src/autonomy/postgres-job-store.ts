import { randomUUID } from "node:crypto";
import type {
  AutonomyJob, AutonomyJobStore, EnqueueAutonomyJob,
} from "./job-store.js";

interface PgResult<Row> { rows: Row[]; rowCount?: number | null }
interface PgQueryable {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<PgResult<Row>>;
}
interface PgClient extends PgQueryable { release(): void }
export interface AutonomyPgPool extends PgQueryable { connect(): Promise<PgClient> }

interface JobRow {
  version: number; id: string; principal_id: string; kind: "research";
  status: AutonomyJob["status"]; payload: unknown; result: unknown; error: string | null;
  idempotency_key: string | null; attempts: number; max_attempts: number;
  created_at: Date | string; updated_at: Date | string; available_at: Date | string;
  lease_worker_id: string | null; lease_expires_at: Date | string | null; checkpoint: { nextCycle: number; cycles: unknown[]; updatedAt: string } | null;
}

const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
function mapJob<TPayload = unknown, TResult = unknown>(row: JobRow): AutonomyJob<TPayload, TResult> {
  return {
    version: 1, id: row.id, principalId: row.principal_id, kind: row.kind,
    status: row.status, payload: row.payload as TPayload,
    ...(row.result !== null ? { result: row.result as TResult } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    attempts: row.attempts, maxAttempts: row.max_attempts,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), availableAt: iso(row.available_at),
    ...(row.lease_worker_id && row.lease_expires_at
      ? { lease: { workerId: row.lease_worker_id, expiresAt: iso(row.lease_expires_at) } }
      : {}),
    ...(row.checkpoint ? { checkpoint: row.checkpoint } : {}),
  };
}

const columns = `version, id, principal_id, kind, status, payload, result, error,
  idempotency_key, attempts, max_attempts, created_at, updated_at, available_at,
  lease_worker_id, lease_expires_at, checkpoint`;

/**
 * PostgreSQL implementation for multi-worker / multi-replica deployments.
 * The supplied pool must be a trusted server-side connection, never client input.
 */
export class PostgresAutonomyJobStore implements AutonomyJobStore {
  constructor(private readonly pool: AutonomyPgPool, private readonly table = "sofia_autonomy_jobs") {
    if (!/^[a-z_][a-z0-9_]*$/.test(table) || table.length > 32) throw new Error("Invalid autonomy job table identifier.");
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
      version integer NOT NULL DEFAULT 1 CHECK (version = 1),
      id uuid PRIMARY KEY,
      principal_id text NOT NULL CHECK (length(principal_id) > 0),
      kind text NOT NULL CHECK (kind = 'research'),
      status text NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
      payload jsonb NOT NULL,
      result jsonb,
      error text,
      idempotency_key text,
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      available_at timestamptz NOT NULL DEFAULT now(),
      lease_worker_id text,
      lease_expires_at timestamptz,
      checkpoint jsonb
    )`);
    await this.pool.query(`ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS checkpoint jsonb`);
    await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${this.table}_principal_idempotency_uq
      ON ${this.table}(principal_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_queue_idx
      ON ${this.table}(status, available_at, created_at)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_principal_idx
      ON ${this.table}(principal_id, created_at DESC)`);
  }

  async enqueue<TPayload>(input: EnqueueAutonomyJob<TPayload>): Promise<AutonomyJob<TPayload>> {
    const principalId = input.principalId.trim();
    if (!principalId) throw new Error("Authenticated principal identity is required.");
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("maxAttempts must be between 1 and 10.");
    if (input.idempotencyKey !== undefined && !input.idempotencyKey.trim()) throw new Error("Idempotency key cannot be empty.");
    const availableAt = input.availableAt ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(availableAt))) throw new Error("Job availableAt must be a valid timestamp.");
    const payload = JSON.stringify(input.payload);
    if (payload === undefined || Buffer.byteLength(payload, "utf8") > 64 * 1024) throw new Error("Job payload must be JSON data no larger than 64 KiB.");
    const id = randomUUID();
    const values = [id, principalId, input.kind, payload, input.idempotencyKey ?? null, maxAttempts, availableAt];
    const inserted = await this.pool.query<JobRow>(
      `INSERT INTO ${this.table} (id, principal_id, kind, status, payload, idempotency_key, max_attempts, available_at)
       VALUES ($1,$2,$3,'queued',$4::jsonb,$5,$6,$7)
       ON CONFLICT (principal_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING ${columns}`, values,
    );
    if (inserted.rows[0]) return mapJob<TPayload>(inserted.rows[0]);
    if (input.idempotencyKey !== undefined) {
      const existing = await this.pool.query<JobRow>(
        `SELECT ${columns} FROM ${this.table} WHERE principal_id=$1 AND idempotency_key=$2`,
        [principalId, input.idempotencyKey],
      );
      if (existing.rows[0]) return mapJob<TPayload>(existing.rows[0]);
    }
    throw new Error("Autonomy job enqueue did not persist a row.");
  }

  async get<TPayload = unknown, TResult = unknown>(principalId: string, jobId: string): Promise<AutonomyJob<TPayload, TResult> | undefined> {
    const result = await this.pool.query<JobRow>(`SELECT ${columns} FROM ${this.table} WHERE principal_id=$1 AND id=$2`, [principalId.trim(), jobId]);
    return result.rows[0] ? mapJob<TPayload, TResult>(result.rows[0]) : undefined;
  }

  async list<TPayload = unknown>(principalId: string): Promise<AutonomyJob<TPayload>[]> {
    const result = await this.pool.query<JobRow>(`SELECT ${columns} FROM ${this.table} WHERE principal_id=$1 ORDER BY created_at DESC LIMIT 500`, [principalId.trim()]);
    return result.rows.map((row) => mapJob<TPayload>(row));
  }

  async claimNext<TPayload = unknown>(workerId: string, leaseMs: number): Promise<AutonomyJob<TPayload> | undefined> {
    if (!workerId.trim() || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000) throw new Error("Invalid worker identity or lease duration.");
    const result = await this.pool.query<JobRow>(
      `WITH candidate AS (
        SELECT id FROM ${this.table}
        WHERE status='queued' AND available_at <= now()
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE ${this.table} AS job
      SET status='running', attempts=job.attempts+1, updated_at=now(),
          lease_worker_id=$1, lease_expires_at=now()+($2::bigint * interval '1 millisecond')
      FROM candidate WHERE job.id=candidate.id
      RETURNING version, job.id, job.principal_id, job.kind, job.status, job.payload, job.result, job.error, job.idempotency_key, job.attempts, job.max_attempts, job.created_at, job.updated_at, job.available_at, job.lease_worker_id, job.lease_expires_at, job.checkpoint `,
      [workerId, leaseMs],
    );
    return result.rows[0] ? mapJob<TPayload>(result.rows[0]) : undefined;
  }

  private async owned(client: PgQueryable, principalId: string, jobId: string, workerId: string): Promise<JobRow> {
    const result = await client.query<JobRow>(
      `SELECT ${columns} FROM ${this.table}
       WHERE principal_id=$1 AND id=$2 AND status='running'
       AND lease_worker_id=$3 AND lease_expires_at > now() FOR UPDATE`,
      [principalId.trim(), jobId, workerId],
    );
    if (!result.rows[0]) throw new Error("Autonomy job lease is missing, expired, or not owned by this worker.");
    return result.rows[0];
  }

  private async transaction<T>(run: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async heartbeat(principalId: string, jobId: string, workerId: string, leaseMs: number): Promise<AutonomyJob> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000) throw new Error("Invalid job lease duration.");
    return this.transaction(async (client) => {
      const row = await this.owned(client, principalId, jobId, workerId);
      const result = await client.query<JobRow>(
        `UPDATE ${this.table} SET lease_expires_at=now()+($4::bigint * interval '1 millisecond'), updated_at=now()
         WHERE id=$1 AND principal_id=$2 AND lease_worker_id=$3 RETURNING ${columns}`,
        [jobId, principalId.trim(), workerId, leaseMs],
      );
      return mapJob(result.rows[0] ?? row);
    });
  }

  async saveCheckpoint(principalId: string, jobId: string, workerId: string, checkpoint: { nextCycle: number; cycles: unknown[] }): Promise<AutonomyJob> {
    if (!Number.isSafeInteger(checkpoint.nextCycle) || checkpoint.nextCycle < 1 || !Array.isArray(checkpoint.cycles) || checkpoint.cycles.length > 100) throw new Error("Invalid autonomy research checkpoint.");
    const json = JSON.stringify({ ...checkpoint, updatedAt: new Date().toISOString() });
    if (Buffer.byteLength(json, "utf8") > 2 * 1024 * 1024) throw new Error("Research checkpoint exceeds 2 MiB.");
    return this.transaction(async (client) => {
      await this.owned(client, principalId, jobId, workerId);
      const result = await client.query<JobRow>(
        `UPDATE ${this.table} SET checkpoint=$4::jsonb, updated_at=now() WHERE id=$1 AND principal_id=$2 AND lease_worker_id=$3 RETURNING ${columns}`,
        [jobId, principalId.trim(), workerId, json],
      );
      if (!result.rows[0]) throw new Error("Autonomy checkpoint update lost its lease.");
      return mapJob(result.rows[0]);
    });
  }
  async complete<TResult>(principalId: string, jobId: string, workerId: string, resultValue: TResult): Promise<AutonomyJob<unknown, TResult>> {
    const json = JSON.stringify(resultValue);
    if (json === undefined || Buffer.byteLength(json, "utf8") > 1024 * 1024) throw new Error("Job result must be JSON data no larger than 1 MiB.");
    return this.transaction(async (client) => {
      await this.owned(client, principalId, jobId, workerId);
      const result = await client.query<JobRow>(
        `UPDATE ${this.table} SET status='completed', result=$4::jsonb, lease_worker_id=NULL,
         lease_expires_at=NULL, updated_at=now() WHERE id=$1 AND principal_id=$2 AND lease_worker_id=$3
         RETURNING ${columns}`, [jobId, principalId.trim(), workerId, json],
      );
      if (!result.rows[0]) throw new Error("Autonomy job completion lost its lease.");
      return mapJob<unknown, TResult>(result.rows[0]);
    });
  }

  async fail(principalId: string, jobId: string, workerId: string, error: string, retryable: boolean): Promise<AutonomyJob> {
    return this.transaction(async (client) => {
      const row = await this.owned(client, principalId, jobId, workerId);
      const status = retryable && row.attempts < row.max_attempts ? "queued" : "failed";
      const result = await client.query<JobRow>(
        `UPDATE ${this.table} SET status=$4, error=$5, lease_worker_id=NULL, lease_expires_at=NULL,
         available_at=now(), updated_at=now() WHERE id=$1 AND principal_id=$2 AND lease_worker_id=$3
         RETURNING ${columns}`, [jobId, principalId.trim(), workerId, status, error.slice(0, 1000)],
      );
      if (!result.rows[0]) throw new Error("Autonomy job failure update lost its lease.");
      return mapJob(result.rows[0]);
    });
  }

  async cancel(principalId: string, jobId: string): Promise<AutonomyJob> {
    const result = await this.pool.query<JobRow>(
      `UPDATE ${this.table} SET status='cancelled', lease_worker_id=NULL, lease_expires_at=NULL, updated_at=now()
       WHERE principal_id=$1 AND id=$2 AND status IN ('queued','running') RETURNING ${columns}`,
      [principalId.trim(), jobId],
    );
    if (result.rows[0]) return mapJob(result.rows[0]);
    const existing = await this.get(principalId, jobId);
    if (existing) return existing;
    throw new Error("Autonomy job not found.");
  }

  async recoverExpired(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE ${this.table} SET status=CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
       error='Worker lease expired; job recovered after interruption.',
       lease_worker_id=NULL, lease_expires_at=NULL, available_at=now(), updated_at=now()
       WHERE status='running' AND lease_expires_at <= now()`,
    );
    return result.rowCount ?? 0;
  }
}
