import type { JobRecord, JobStateStore, OwnedJobStateStore } from "./job-runtime.js";

/**
 * Minimal node-postgres-compatible query boundary. Keep the core independent
 * from a particular driver; pass a Pool or Client adapter from the host app.
 */
export interface PostgresQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount?: number | null;
}
export interface PostgresExecutor {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<PostgresQueryResult<Row>>;
}

type JobRow = {
  id: string; status: JobRecord["status"]; created_at: Date | string; updated_at: Date | string;
  task: string; model_route_id: string | null; owner_key_id: string | null;
  notification_channel_id: string | null; session_key: string | null; session_task: string | null;
  notification_delivered: boolean; lease_owner_token: string | null; lease_expires_at: Date | string | null;
  heartbeat_at: Date | string | null; resume_reservation_token: string | null;
  resume_reservation_expires_at: Date | string | null; snapshot: JobRecord["snapshot"] | null;
  result: JobRecord["result"] | null; error: string | null;
};

function iso(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
function jsonValue<T>(value: T | string | null): T | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string") return value;
  return JSON.parse(value) as T;
}
function fromRow(row: JobRow): JobRecord {
  return {
    id: row.id, status: row.status, createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!,
    task: row.task,
    ...(row.model_route_id ? { modelRouteId: row.model_route_id } : {}),
    ...(row.owner_key_id ? { ownerKeyId: row.owner_key_id } : {}),
    ...(row.notification_channel_id ? { notificationChannelId: row.notification_channel_id } : {}),
    ...(row.session_key ? { sessionKey: row.session_key } : {}),
    ...(row.session_task ? { sessionTask: row.session_task } : {}),
    notificationDelivered: row.notification_delivered,
    ...(row.lease_owner_token ? { leaseOwnerToken: row.lease_owner_token } : {}),
    ...(iso(row.lease_expires_at) ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    ...(iso(row.heartbeat_at) ? { heartbeatAt: iso(row.heartbeat_at) } : {}),
    ...(row.resume_reservation_token ? { resumeReservationToken: row.resume_reservation_token } : {}),
    ...(iso(row.resume_reservation_expires_at) ? { resumeReservationExpiresAt: iso(row.resume_reservation_expires_at) } : {}),
    ...(jsonValue(row.snapshot) ? { snapshot: jsonValue(row.snapshot) } : {}),
    ...(jsonValue(row.result) ? { result: jsonValue(row.result) } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}
const COLUMNS = `id,status,created_at,updated_at,task,model_route_id,owner_key_id,
notification_channel_id,session_key,session_task,notification_delivered,lease_owner_token,
lease_expires_at,heartbeat_at,resume_reservation_token,resume_reservation_expires_at,snapshot,result,error`;

/**
 * Shared PostgreSQL JobStateStore. Every state transition is one conditional
 * SQL statement, so lease fencing and owner predicates are enforced by the DB.
 * Supply a Pool (not a transaction-bound Client) for normal use.
 */
export class PostgresJobStateStore implements JobStateStore, OwnedJobStateStore {
  constructor(private readonly db: PostgresExecutor) {}

  async claim(id: string, ownerToken: string, leaseMs: number, resumeReservationToken?: string): Promise<JobRecord | undefined> {
    const result = await this.db.query<JobRow>(
      `UPDATE sofia_agent_jobs SET status='running', lease_owner_token=$2::uuid,
        heartbeat_at=now(), lease_expires_at=now()+($3::text || ' milliseconds')::interval,
        resume_reservation_token=NULL,resume_reservation_expires_at=NULL,error=NULL,updated_at=now()
       WHERE id=$1::uuid AND status NOT IN ('completed','cancelled')
         AND (status <> 'running' OR lease_expires_at IS NULL OR lease_expires_at <= now())
         AND (resume_reservation_token IS NULL OR resume_reservation_expires_at IS NULL
              OR resume_reservation_expires_at <= now() OR resume_reservation_token=$4::uuid)
         AND ($4::uuid IS NULL OR resume_reservation_token=$4::uuid)
       RETURNING ${COLUMNS}`,
      [id, ownerToken, Math.max(1, Math.floor(leaseMs)), resumeReservationToken ?? null],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async heartbeat(id: string, ownerToken: string, leaseMs: number): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE sofia_agent_jobs SET heartbeat_at=now(),
        lease_expires_at=now()+($3::text || ' milliseconds')::interval,updated_at=now()
       WHERE id=$1::uuid AND status='running' AND lease_owner_token=$2::uuid
         AND lease_expires_at > now() RETURNING id`,
      [id, ownerToken, Math.max(1, Math.floor(leaseMs))],
    );
    return (result.rowCount ?? result.rows.length) > 0;
  }

  async markInterruptedIfExpired(id: string): Promise<JobRecord | undefined> {
    const result = await this.db.query<JobRow>(
      `UPDATE sofia_agent_jobs SET status='failed',
        error=CASE WHEN snapshot IS NULL
          THEN 'Job lease expired before a resumable snapshot was saved.'
          ELSE 'Job lease expired after a worker stopped heartbeating; resume it from the saved snapshot.' END,
        lease_owner_token=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE id=$1::uuid AND status='running'
         AND (lease_expires_at IS NULL OR lease_expires_at <= now())
       RETURNING ${COLUMNS}`,
      [id],
    );
    if (result.rows[0]) return fromRow(result.rows[0]);
    return this.get(id);
  }

  async cancel(id: string): Promise<JobRecord | undefined> {
    const result = await this.db.query<JobRow>(
      `UPDATE sofia_agent_jobs SET status='cancelled',
        error=COALESCE(error,'Job cancelled by caller.'),updated_at=now()
       WHERE id=$1::uuid AND status NOT IN ('completed','failed','cancelled')
       RETURNING ${COLUMNS}`,
      [id],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async cancelForOwner(id: string, ownerKeyId: string): Promise<JobRecord | undefined> {
    const result = await this.db.query<JobRow>(
      `UPDATE sofia_agent_jobs SET status='cancelled',
        error=COALESCE(error,'Job cancelled by caller.'),updated_at=now()
       WHERE id=$1::uuid AND owner_key_id=$2 AND status NOT IN ('completed','failed','cancelled')
       RETURNING ${COLUMNS}`,
      [id, ownerKeyId],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async save(record: JobRecord): Promise<boolean> {
    const result = await this.db.query(
      `INSERT INTO sofia_agent_jobs (
        id,status,created_at,updated_at,task,model_route_id,owner_key_id,notification_channel_id,
        session_key,session_task,notification_delivered,lease_owner_token,lease_expires_at,
        heartbeat_at,resume_reservation_token,resume_reservation_expires_at,snapshot,result,error
      ) VALUES (
        $1::uuid,$2,$3::timestamptz,$4::timestamptz,$5,$6,$7,$8,$9,$10,$11,
        $12::uuid,$13::timestamptz,$14::timestamptz,$15::uuid,$16::timestamptz,$17::jsonb,$18::jsonb,$19
      )
      ON CONFLICT (id) DO UPDATE SET
        status=EXCLUDED.status,updated_at=EXCLUDED.updated_at,task=EXCLUDED.task,
        model_route_id=EXCLUDED.model_route_id,notification_channel_id=EXCLUDED.notification_channel_id,
        session_key=EXCLUDED.session_key,session_task=EXCLUDED.session_task,
        notification_delivered=EXCLUDED.notification_delivered,
        lease_owner_token=EXCLUDED.lease_owner_token,lease_expires_at=EXCLUDED.lease_expires_at,
        heartbeat_at=EXCLUDED.heartbeat_at,
        resume_reservation_token=CASE
          WHEN sofia_agent_jobs.resume_reservation_token IS NOT NULL
            AND sofia_agent_jobs.resume_reservation_expires_at > now()
            AND EXCLUDED.resume_reservation_token IS DISTINCT FROM sofia_agent_jobs.resume_reservation_token
          THEN sofia_agent_jobs.resume_reservation_token ELSE EXCLUDED.resume_reservation_token END,
        resume_reservation_expires_at=CASE
          WHEN sofia_agent_jobs.resume_reservation_token IS NOT NULL
            AND sofia_agent_jobs.resume_reservation_expires_at > now()
            AND EXCLUDED.resume_reservation_token IS DISTINCT FROM sofia_agent_jobs.resume_reservation_token
          THEN sofia_agent_jobs.resume_reservation_expires_at ELSE EXCLUDED.resume_reservation_expires_at END,
        snapshot=EXCLUDED.snapshot,result=EXCLUDED.result,error=EXCLUDED.error
      WHERE sofia_agent_jobs.owner_key_id IS NOT DISTINCT FROM EXCLUDED.owner_key_id
        AND sofia_agent_jobs.lease_owner_token IS NOT DISTINCT FROM EXCLUDED.lease_owner_token
        AND (sofia_agent_jobs.status <> 'running' OR sofia_agent_jobs.lease_expires_at > now())
        AND (sofia_agent_jobs.status <> 'cancelled' OR EXCLUDED.status='cancelled')
      RETURNING id`,
      [record.id,record.status,record.createdAt,record.updatedAt,record.task,record.modelRouteId ?? null,
       record.ownerKeyId ?? null,record.notificationChannelId ?? null,record.sessionKey ?? null,
       record.sessionTask ?? null,record.notificationDelivered ?? false,record.leaseOwnerToken ?? null,
       record.leaseExpiresAt ?? null,record.heartbeatAt ?? null,record.resumeReservationToken ?? null,
       record.resumeReservationExpiresAt ?? null,record.snapshot ? JSON.stringify(record.snapshot) : null,
       record.result ? JSON.stringify(record.result) : null,record.error ?? null],
    );
    return (result.rowCount ?? result.rows.length) > 0;
  }


  /**
   * Atomically persists a terminal job transition and its notification event.
   * The outbox row is inserted only when the job update passes the same lease,
   * owner, and cancellation fences as save(). The executor executes this as one
   * PostgreSQL statement, hence one database transaction.
   */
  async saveTerminalWithOutbox(
    record: JobRecord,
    eventType: string,
    payload: unknown,
  ): Promise<boolean> {
    if (!["completed", "failed", "cancelled"].includes(record.status)) {
      throw new Error("Atomic outbox persistence requires a terminal job status.");
    }
    const result = await this.db.query<{ id: string }>(
      `WITH updated AS (
        UPDATE sofia_agent_jobs SET
          status=$2,updated_at=$4::timestamptz,task=$5,model_route_id=$6,
          notification_channel_id=$8,session_key=$9,session_task=$10,
          notification_delivered=$11,lease_owner_token=$12::uuid,
          lease_expires_at=$13::timestamptz,heartbeat_at=$14::timestamptz,
          resume_reservation_token=NULL,resume_reservation_expires_at=NULL,
          snapshot=$17::jsonb,result=$18::jsonb,error=$19
        WHERE id=$1::uuid
          AND owner_key_id IS NOT DISTINCT FROM $7
          AND lease_owner_token IS NOT DISTINCT FROM $12::uuid
          AND (status <> 'running' OR lease_expires_at > now())
          AND (status <> 'cancelled' OR $2='cancelled')
        RETURNING id,owner_key_id,notification_channel_id
      ), inserted AS (
        INSERT INTO sofia_agent_outbox
          (id,owner_key_id,job_id,event_type,destination,payload,available_at)
        SELECT $3::uuid,u.owner_key_id,u.id,$20,u.notification_channel_id,$21::jsonb,now()
        FROM updated u
        WHERE u.notification_channel_id IS NOT NULL
        ON CONFLICT (job_id,event_type,destination) DO NOTHING
        RETURNING id
      )
      SELECT id FROM updated`,
      [record.id,record.status,crypto.randomUUID(),record.updatedAt,record.task,
       record.modelRouteId??null,record.ownerKeyId??null,record.notificationChannelId??null,
       record.sessionKey??null,record.sessionTask??null,record.notificationDelivered??false,
       record.leaseOwnerToken??null,record.leaseExpiresAt??null,record.heartbeatAt??null,
       null,null,record.snapshot?JSON.stringify(record.snapshot):null,
       record.result?JSON.stringify(record.result):null,record.error??null,
       eventType,JSON.stringify(payload)],
    );
    return (result.rowCount ?? result.rows.length) > 0;
  }

  async list(): Promise<JobRecord[]> {
    const result = await this.db.query<JobRow>(`SELECT ${COLUMNS} FROM sofia_agent_jobs ORDER BY created_at DESC LIMIT 500`);
    return result.rows.map(fromRow);
  }

  async get(id: string): Promise<JobRecord | undefined> {
    const result = await this.db.query<JobRow>(`SELECT ${COLUMNS} FROM sofia_agent_jobs WHERE id=$1::uuid LIMIT 1`,[id]);
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async getForOwner(id: string, ownerKeyId: string): Promise<JobRecord | undefined> {
    const result = await this.db.query<JobRow>(
      `SELECT ${COLUMNS} FROM sofia_agent_jobs WHERE id=$1::uuid AND owner_key_id=$2 LIMIT 1`,[id,ownerKeyId]);
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async listForOwner(ownerKeyId: string, limit: number): Promise<JobRecord[]> {
    const bounded = Math.max(1,Math.min(200,Math.floor(limit)));
    const result = await this.db.query<JobRow>(
      `SELECT ${COLUMNS} FROM sofia_agent_jobs WHERE owner_key_id=$1 ORDER BY created_at DESC LIMIT $2`,[ownerKeyId,bounded]);
    return result.rows.map(fromRow);
  }

  async reserveResumeForOwner(id: string, ownerKeyId: string, reservationToken: string, reservationMs: number): Promise<JobRecord | undefined> {
    const result = await this.db.query<JobRow>(
      `UPDATE sofia_agent_jobs SET resume_reservation_token=$3::uuid,
        resume_reservation_expires_at=now()+($4::text || ' milliseconds')::interval,updated_at=now()
       WHERE id=$1::uuid AND owner_key_id=$2
         AND status NOT IN ('completed','cancelled') AND snapshot IS NOT NULL
         AND (status <> 'running' OR lease_expires_at IS NULL OR lease_expires_at <= now())
         AND (resume_reservation_token IS NULL OR resume_reservation_expires_at IS NULL
              OR resume_reservation_expires_at <= now())
       RETURNING ${COLUMNS}`,
      [id,ownerKeyId,reservationToken,Math.max(1,Math.floor(reservationMs))],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }
}
