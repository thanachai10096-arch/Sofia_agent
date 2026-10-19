import { redactSecrets } from "../security/guard.js";
import type { JobRecord } from "./job-runtime.js";

/** Structural subset of a PostgreSQL client pool (for example node-postgres). */
export interface JobSqlResult<Row = Record<string, unknown>> { rows: Row[]; }
export interface JobSqlClient {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<JobSqlResult<Row>>;
  release(): void;
}
export interface JobSqlPool {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<JobSqlResult<Row>>;
  connect(): Promise<JobSqlClient>;
}

export interface DurableJobStateStore {
  save(record: JobRecord): Promise<boolean>;
  get(id: string): Promise<JobRecord | undefined>;
  list(): Promise<JobRecord[]>;
  claim(id: string, ownerToken: string, leaseMs: number): Promise<JobRecord | undefined>;
  heartbeat(id: string, ownerToken: string, leaseMs: number): Promise<boolean>;
  markInterruptedIfExpired(id: string): Promise<JobRecord | undefined>;
  cancel(id: string): Promise<JobRecord | undefined>;
}

function safeRecord(record: JobRecord): JobRecord {
  return {
    ...record,
    task: String(redactSecrets(record.task)),
    ...(record.sessionTask ? { sessionTask: String(redactSecrets(record.sessionTask)) } : {}),
    ...(record.snapshot ? { snapshot: redactSecrets(record.snapshot) as JobRecord["snapshot"] } : {}),
    ...(record.result ? { result: redactSecrets(record.result) as JobRecord["result"] } : {}),
    ...(record.error ? { error: String(redactSecrets(record.error)) } : {}),
  };
}

function decodeRecord(value: unknown): JobRecord {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid persisted job record.");
  const record = parsed as Partial<JobRecord>;
  if (typeof record.id !== "string" || !record.id ||
      !["queued", "running", "completed", "failed", "cancelled"].includes(String(record.status)) ||
      typeof record.task !== "string" || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") {
    throw new Error("Invalid persisted job record.");
  }
  return safeRecord(record as JobRecord);
}

/**
 * Transactional job-state store for multiple workers sharing PostgreSQL.
 * Every state mutation locks the row and validates the lease fencing token.
 * Run ensureSchema() during controlled startup/migration before accepting jobs.
 */
export class PostgresJobStateStore implements DurableJobStateStore {
  constructor(private readonly pool: JobSqlPool) {}

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sofia_durable_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
        lease_owner_token TEXT,
        lease_expires_at BIGINT,
        owner_key_id TEXT,
        updated_at BIGINT NOT NULL,
        record JSONB NOT NULL
      )
    `);
    await this.pool.query("CREATE INDEX IF NOT EXISTS sofia_durable_jobs_claim_idx ON sofia_durable_jobs (status, lease_expires_at)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS sofia_durable_jobs_owner_idx ON sofia_durable_jobs (owner_key_id, updated_at DESC)");
  }

  private async locked<T>(operation: (client: JobSqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async readLocked(client: JobSqlClient, id: string): Promise<JobRecord | undefined> {
    const result = await client.query<{ record: unknown }>(
      "SELECT record FROM sofia_durable_jobs WHERE id = $1 FOR UPDATE", [id],
    );
    return result.rows[0] ? decodeRecord(result.rows[0].record) : undefined;
  }

  private async writeLocked(client: JobSqlClient, record: JobRecord): Promise<void> {
    const safe = safeRecord(record);
    const leaseExpiry = safe.leaseExpiresAt ? Date.parse(safe.leaseExpiresAt) : null;
    await client.query(
      `INSERT INTO sofia_durable_jobs (id,status,lease_owner_token,lease_expires_at,owner_key_id,updated_at,record)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, lease_owner_token=EXCLUDED.lease_owner_token,
         lease_expires_at=EXCLUDED.lease_expires_at, owner_key_id=EXCLUDED.owner_key_id,
         updated_at=EXCLUDED.updated_at, record=EXCLUDED.record`,
      [safe.id, safe.status, safe.leaseOwnerToken ?? null,
       leaseExpiry !== null && Number.isFinite(leaseExpiry) ? leaseExpiry : null,
       safe.ownerKeyId ?? null, Date.parse(safe.updatedAt) || Date.now(), JSON.stringify(safe)],
    );
  }

  async save(input: JobRecord): Promise<boolean> {
    return this.locked(async (client) => {
      const current = await this.readLocked(client, input.id);
      if (current) {
        if (current.leaseOwnerToken !== input.leaseOwnerToken) return false;
        if (current.status === "cancelled" && input.status !== "cancelled") return false;
        const record: JobRecord = {
          ...input,
          ...(input.status === "running" && current.status === "running"
            ? { leaseExpiresAt: current.leaseExpiresAt, heartbeatAt: current.heartbeatAt }
            : {}),
        };
        await this.writeLocked(client, record);
      } else {
        await this.writeLocked(client, input);
      }
      return true;
    });
  }

  async get(id: string): Promise<JobRecord | undefined> {
    const result = await this.pool.query<{ record: unknown }>("SELECT record FROM sofia_durable_jobs WHERE id = $1", [id]);
    return result.rows[0] ? decodeRecord(result.rows[0].record) : undefined;
  }

  async list(): Promise<JobRecord[]> {
    const result = await this.pool.query<{ record: unknown }>("SELECT record FROM sofia_durable_jobs ORDER BY updated_at ASC");
    return result.rows.map((row) => decodeRecord(row.record));
  }

  async claim(id: string, ownerToken: string, leaseMs: number): Promise<JobRecord | undefined> {
    return this.locked(async (client) => {
      const record = await this.readLocked(client, id);
      if (!record || record.status === "completed" || record.status === "cancelled") return undefined;
      const now = Date.now();
      const expires = record.leaseExpiresAt ? Date.parse(record.leaseExpiresAt) : 0;
      if (record.status === "running" && Number.isFinite(expires) && expires > now) return undefined;
      const claimed: JobRecord = {
        ...record, status: "running", leaseOwnerToken: ownerToken,
        heartbeatAt: new Date(now).toISOString(), leaseExpiresAt: new Date(now + leaseMs).toISOString(),
        updatedAt: new Date(now).toISOString(), error: undefined,
      };
      await this.writeLocked(client, claimed);
      return claimed;
    });
  }

  async heartbeat(id: string, ownerToken: string, leaseMs: number): Promise<boolean> {
    return this.locked(async (client) => {
      const record = await this.readLocked(client, id);
      const now = Date.now();
      const expires = record?.leaseExpiresAt ? Date.parse(record.leaseExpiresAt) : 0;
      if (!record || record.status !== "running" || record.leaseOwnerToken !== ownerToken ||
          !Number.isFinite(expires) || expires <= now) return false;
      record.heartbeatAt = new Date(now).toISOString();
      record.leaseExpiresAt = new Date(now + leaseMs).toISOString();
      record.updatedAt = new Date(now).toISOString();
      await this.writeLocked(client, record);
      return true;
    });
  }

  async markInterruptedIfExpired(id: string): Promise<JobRecord | undefined> {
    return this.locked(async (client) => {
      const record = await this.readLocked(client, id);
      if (!record || record.status !== "running") return record;
      const expires = record.leaseExpiresAt ? Date.parse(record.leaseExpiresAt) : 0;
      if (Number.isFinite(expires) && expires > Date.now()) return record;
      record.status = "failed";
      record.error = record.snapshot
        ? "Job lease expired after a worker stopped heartbeating; resume it from the saved snapshot."
        : "Job lease expired before a resumable snapshot was saved.";
      record.leaseOwnerToken = undefined;
      record.leaseExpiresAt = undefined;
      record.updatedAt = new Date().toISOString();
      await this.writeLocked(client, record);
      return record;
    });
  }

  async cancel(id: string): Promise<JobRecord | undefined> {
    return this.locked(async (client) => {
      const record = await this.readLocked(client, id);
      if (!record || ["completed", "failed", "cancelled"].includes(record.status)) return undefined;
      record.status = "cancelled";
      record.error ??= "Job cancelled by caller.";
      record.updatedAt = new Date().toISOString();
      await this.writeLocked(client, record);
      return record;
    });
  }
}
