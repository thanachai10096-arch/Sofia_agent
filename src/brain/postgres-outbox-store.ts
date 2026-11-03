import type { PostgresExecutor } from "./postgres-job-state-store.js";

export type OutboxStatus = "pending" | "processing" | "delivered" | "failed";
export interface OutboxMessage {
  id: string;
  ownerKeyId?: string;
  jobId: string;
  eventType: string;
  destination: string;
  payload: unknown;
  status: OutboxStatus;
  attempts: number;
  availableAt: string;
  leaseOwnerToken?: string;
  leaseExpiresAt?: string;
  lastError?: string;
  createdAt: string;
  deliveredAt?: string;
}
export interface EnqueueOutboxMessage {
  id: string;
  ownerKeyId?: string;
  jobId: string;
  eventType: string;
  destination: string;
  payload: unknown;
  availableAt?: string;
}
export interface OutboxStore {
  enqueue(message: EnqueueOutboxMessage): Promise<boolean>;
  claimBatch(workerToken: string, limit: number, leaseMs: number): Promise<OutboxMessage[]>;
  markDelivered(id: string, workerToken: string): Promise<boolean>;
  /** Extends only a currently valid lease owned by this worker. */
  renewLease?(id: string, workerToken: string, leaseMs: number): Promise<boolean>;
  retry(id: string, workerToken: string, error: string, delayMs: number, maxAttempts: number): Promise<boolean>;
}
type OutboxRow = {
  id:string; owner_key_id:string|null; job_id:string; event_type:string; destination:string;
  payload:unknown|string; status:OutboxStatus; attempts:number; available_at:Date|string;
  lease_owner_token:string|null; lease_expires_at:Date|string|null; last_error:string|null;
  created_at:Date|string; delivered_at:Date|string|null;
};
const COLUMNS = `id,owner_key_id,job_id,event_type,destination,payload,status,attempts,
available_at,lease_owner_token,lease_expires_at,last_error,created_at,delivered_at`;
function date(value:Date|string|null):string|undefined {
  if(value===null)return undefined;
  const parsed=value instanceof Date?value:new Date(value);
  if(!Number.isFinite(parsed.getTime())) throw new Error("Invalid timestamp returned by outbox storage.");
  return parsed.toISOString();
}
function mapRow(row:OutboxRow):OutboxMessage {
  const payload=typeof row.payload==="string"?JSON.parse(row.payload):row.payload;
  return {
    id:row.id,jobId:row.job_id,eventType:row.event_type,destination:row.destination,payload,
    status:row.status,attempts:row.attempts,availableAt:date(row.available_at)!,
    createdAt:date(row.created_at)!,
    ...(row.owner_key_id?{ownerKeyId:row.owner_key_id}:{}),
    ...(row.lease_owner_token?{leaseOwnerToken:row.lease_owner_token}:{}),
    ...(date(row.lease_expires_at)?{leaseExpiresAt:date(row.lease_expires_at)}:{}),
    ...(row.last_error?{lastError:row.last_error}:{}),
    ...(date(row.delivered_at)?{deliveredAt:date(row.delivered_at)}:{}),
  };
}

/** PostgreSQL transactional outbox. Delivery is at-least-once; consumers should use message id for deduplication. */
export class PostgresOutboxStore implements OutboxStore {
  constructor(private readonly db:PostgresExecutor) {}

  async enqueue(message:EnqueueOutboxMessage):Promise<boolean> {
    // Never let an enqueue caller invent or reassign a tenant or notification
    // destination. Both must match the persisted job row exactly.
    const result=await this.db.query(
      `INSERT INTO sofia_agent_outbox
       (id,owner_key_id,job_id,event_type,destination,payload,available_at)
       SELECT $1::uuid,j.owner_key_id,j.id,$5,$4,$6::jsonb,COALESCE($7::timestamptz,now())
       FROM sofia_agent_jobs AS j
       WHERE j.id=$3::uuid
         AND j.owner_key_id IS NOT DISTINCT FROM $2::text
         AND j.notification_channel_id=$4
       ON CONFLICT (job_id,event_type,destination) DO NOTHING RETURNING id`,
      [message.id,message.ownerKeyId??null,message.jobId,message.destination,message.eventType,
       JSON.stringify(message.payload),message.availableAt??null],
    );
    return (result.rowCount??result.rows.length)>0;
  }

  async claimBatch(workerToken:string,limit:number,leaseMs:number):Promise<OutboxMessage[]> {
    const boundedLimit=Math.max(1,Math.min(100,Math.floor(limit)));
    const boundedLease=Math.max(1000,Math.min(300000,Math.floor(leaseMs)));
    const result=await this.db.query<OutboxRow>(
      `WITH candidates AS (
         SELECT id FROM sofia_agent_outbox
         WHERE available_at<=now()
           AND (status='pending' OR (status='processing' AND lease_expires_at<=now()))
         ORDER BY available_at,created_at
         FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE sofia_agent_outbox AS o SET status='processing',attempts=o.attempts+1,
         lease_owner_token=$1::uuid,
         lease_expires_at=now()+($3::text || ' milliseconds')::interval
       FROM candidates c WHERE o.id=c.id
       RETURNING o.id,o.owner_key_id,o.job_id,o.event_type,o.destination,o.payload,o.status,o.attempts,
         o.available_at,o.lease_owner_token,o.lease_expires_at,o.last_error,o.created_at,o.delivered_at`,
      [workerToken,boundedLimit,boundedLease],
    );
    return result.rows.map(mapRow);
  }

  async renewLease(id:string,workerToken:string,leaseMs:number):Promise<boolean> {
    const boundedLease=Math.max(1000,Math.min(300000,Math.floor(leaseMs)));
    const result=await this.db.query(
      `UPDATE sofia_agent_outbox SET
         lease_expires_at=now()+($3::text || ' milliseconds')::interval
       WHERE id=$1::uuid AND status='processing' AND lease_owner_token=$2::uuid
         AND lease_expires_at>now() RETURNING id`,
      [id,workerToken,boundedLease],
    );
    return (result.rowCount??result.rows.length)>0;
  }

  async markDelivered(id:string,workerToken:string):Promise<boolean> {
    const result=await this.db.query(
      `UPDATE sofia_agent_outbox SET status='delivered',delivered_at=now(),
       lease_owner_token=NULL,lease_expires_at=NULL,last_error=NULL
       WHERE id=$1::uuid AND status='processing' AND lease_owner_token=$2::uuid
         AND lease_expires_at>now() RETURNING id`,
      [id,workerToken],
    );
    return (result.rowCount??result.rows.length)>0;
  }

  async retry(id:string,workerToken:string,error:string,delayMs:number,maxAttempts:number):Promise<boolean> {
    const delay=Math.max(0,Math.min(86400000,Math.floor(delayMs)));
    const attempts=Math.max(1,Math.min(100,Math.floor(maxAttempts)));
    const result=await this.db.query(
      `UPDATE sofia_agent_outbox SET
         status=CASE WHEN attempts >= $5 THEN 'failed' ELSE 'pending' END,
         available_at=now()+($4::text || ' milliseconds')::interval,
         last_error=left($3,2000),lease_owner_token=NULL,lease_expires_at=NULL
       WHERE id=$1::uuid AND status='processing' AND lease_owner_token=$2::uuid
         AND lease_expires_at>now() RETURNING id`,
      [id,workerToken,error,delay,attempts],
    );
    return (result.rowCount??result.rows.length)>0;
  }
}
