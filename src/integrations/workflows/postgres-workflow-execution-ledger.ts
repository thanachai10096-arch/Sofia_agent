import { randomUUID } from "node:crypto";
import type { WorkflowExecutionState } from "./workflow-engine.js";
import {
  canTransitionWorkflowExecution,
  type ReserveWorkflowExecution,
  type WorkflowExecutionLedger,
  type WorkflowExecutionRecord,
  type WorkflowReservation,
} from "./workflow-execution-ledger.js";

/** Minimal structural subset of node-postgres; no driver dependency is imposed. */
export interface WorkflowLedgerQueryResult<Row = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}
export interface WorkflowLedgerSqlClient {
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<WorkflowLedgerQueryResult<Row>>;
  release(): void;
}
export interface WorkflowLedgerSqlPool {
  connect(): Promise<WorkflowLedgerSqlClient>;
}

interface WorkflowLedgerRow {
  execution_id: string;
  workflow_id: string;
  idempotency_key: string;
  payload_hash: string;
  correlation_id: string;
  status: WorkflowExecutionState;
  created_at: Date | string;
  updated_at: Date | string;
  provider_execution_id: string | null;
  output_json: unknown;
  safe_error_code: string | null;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function fromRow(row: WorkflowLedgerRow): WorkflowExecutionRecord {
  return {
    executionId: row.execution_id,
    workflowId: row.workflow_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    correlationId: row.correlation_id,
    status: row.status,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    ...(row.provider_execution_id ? { providerExecutionId: row.provider_execution_id } : {}),
    ...(row.output_json !== null && row.output_json !== undefined ? { output: row.output_json } : {}),
    ...(row.safe_error_code ? { safeErrorCode: row.safe_error_code } : {}),
  };
}

/**
 * PostgreSQL-backed execution ledger. The caller must provision the migration
 * before enabling workflow dispatch. All reservation and state transitions are
 * transactional and safe across processes sharing the same PostgreSQL database.
 */
export class PostgresWorkflowExecutionLedger implements WorkflowExecutionLedger {
  constructor(private readonly pool: WorkflowLedgerSqlPool) {}

  async reserve(input: ReserveWorkflowExecution): Promise<WorkflowReservation> {
    if (!input.workflowId.trim() || !input.idempotencyKey.trim() ||
        !input.payloadHash.trim() || !input.correlationId.trim()) {
      throw new Error("workflow_request_identity_required");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const executionId = randomUUID();
      const inserted = await client.query<WorkflowLedgerRow>(
        `INSERT INTO sofia_workflow_executions
          (execution_id, workflow_id, idempotency_key, payload_hash, correlation_id, status)
         VALUES ($1, $2, $3, $4, $5, 'accepted')
         ON CONFLICT (workflow_id, idempotency_key) DO NOTHING
         RETURNING execution_id, workflow_id, idempotency_key, payload_hash,
                   correlation_id, status, created_at, updated_at,
                   provider_execution_id, output_json, safe_error_code`,
        [executionId, input.workflowId, input.idempotencyKey, input.payloadHash, input.correlationId],
      );
      if (inserted.rows[0]) {
        await client.query("COMMIT");
        return { kind: "created", record: fromRow(inserted.rows[0]) };
      }

      const existing = await client.query<WorkflowLedgerRow>(
        `SELECT execution_id, workflow_id, idempotency_key, payload_hash,
                correlation_id, status, created_at, updated_at,
                provider_execution_id, output_json, safe_error_code
           FROM sofia_workflow_executions
          WHERE workflow_id = $1 AND idempotency_key = $2
          FOR UPDATE`,
        [input.workflowId, input.idempotencyKey],
      );
      const row = existing.rows[0];
      if (!row) throw new Error("workflow_ledger_reservation_race");
      if (row.payload_hash !== input.payloadHash || row.correlation_id !== input.correlationId) {
        throw new Error("workflow_idempotency_conflict");
      }
      await client.query("COMMIT");
      return { kind: "existing", record: fromRow(row) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async update(
    executionId: string,
    expectedStatus: WorkflowExecutionState,
    patch: Pick<WorkflowExecutionRecord, "status"> &
      Partial<Pick<WorkflowExecutionRecord, "providerExecutionId" | "output" | "safeErrorCode">>,
  ): Promise<WorkflowExecutionRecord | undefined> {
    if (expectedStatus === "indeterminate") {
      throw new Error("workflow_reconciliation_required");
    }
    return this.updateRecord(executionId, expectedStatus, patch);
  }

  async reconcile(
    executionId: string,
    patch: Pick<WorkflowExecutionRecord, "status"> &
      Partial<Pick<WorkflowExecutionRecord, "providerExecutionId" | "output" | "safeErrorCode">>,
  ): Promise<WorkflowExecutionRecord | undefined> {
    if (!["succeeded", "failed", "cancelled"].includes(patch.status)) {
      throw new Error("workflow_reconciliation_invalid_outcome");
    }
    return this.updateRecord(executionId, "indeterminate", patch);
  }

  private async updateRecord(
    executionId: string,
    expectedStatus: WorkflowExecutionState,
    patch: Pick<WorkflowExecutionRecord, "status"> &
      Partial<Pick<WorkflowExecutionRecord, "providerExecutionId" | "output" | "safeErrorCode">>,
  ): Promise<WorkflowExecutionRecord | undefined> {
    if (!canTransitionWorkflowExecution(expectedStatus, patch.status)) {
      throw new Error("workflow_execution_invalid_transition");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<WorkflowLedgerRow>(
        `SELECT execution_id, workflow_id, idempotency_key, payload_hash,
                correlation_id, status, created_at, updated_at,
                provider_execution_id, output_json, safe_error_code
           FROM sofia_workflow_executions WHERE execution_id = $1 FOR UPDATE`,
        [executionId],
      );
      const row = current.rows[0];
      if (!row || row.status !== expectedStatus) {
        await client.query("ROLLBACK");
        return undefined;
      }
      const updated = await client.query<WorkflowLedgerRow>(
        `UPDATE sofia_workflow_executions
            SET status = $3,
                provider_execution_id = COALESCE($4, provider_execution_id),
                output_json = CASE WHEN $5::boolean THEN $6::jsonb ELSE output_json END,
                safe_error_code = CASE WHEN $7::boolean THEN $8 ELSE safe_error_code END,
                updated_at = NOW()
          WHERE execution_id = $1 AND status = $2
          RETURNING execution_id, workflow_id, idempotency_key, payload_hash,
                    correlation_id, status, created_at, updated_at,
                    provider_execution_id, output_json, safe_error_code`,
        [
          executionId,
          expectedStatus,
          patch.status,
          patch.providerExecutionId ?? null,
          Object.prototype.hasOwnProperty.call(patch, "output"),
          patch.output === undefined ? null : JSON.stringify(patch.output),
          Object.prototype.hasOwnProperty.call(patch, "safeErrorCode"),
          patch.safeErrorCode ?? null,
        ],
      );
      await client.query("COMMIT");
      return updated.rows[0] ? fromRow(updated.rows[0]) : undefined;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async get(executionId: string): Promise<WorkflowExecutionRecord | undefined> {
    const result = await this.pool.connect();
    try {
      const response = await result.query<WorkflowLedgerRow>(
        `SELECT execution_id, workflow_id, idempotency_key, payload_hash,
                correlation_id, status, created_at, updated_at,
                provider_execution_id, output_json, safe_error_code
           FROM sofia_workflow_executions WHERE execution_id = $1`,
        [executionId],
      );
      return response.rows[0] ? fromRow(response.rows[0]) : undefined;
    } finally {
      result.release();
    }
  }

  async listForReconciliation(
    olderThan: string,
    limit: number,
  ): Promise<readonly WorkflowExecutionRecord[]> {
    const cutoff = new Date(olderThan);
    if (!Number.isFinite(cutoff.getTime())) throw new Error("workflow_reconciliation_cutoff_invalid");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("workflow_reconciliation_limit_invalid");
    }
    const client = await this.pool.connect();
    try {
      const response = await client.query<WorkflowLedgerRow>(
        `SELECT execution_id, workflow_id, idempotency_key, payload_hash,
                correlation_id, status, created_at, updated_at,
                provider_execution_id, output_json, safe_error_code
           FROM sofia_workflow_executions
          WHERE status IN ('running', 'indeterminate')
            AND updated_at <= $1::timestamptz
          ORDER BY updated_at ASC, execution_id ASC
          LIMIT $2`,
        [cutoff.toISOString(), limit],
      );
      return response.rows.map(fromRow);
    } finally {
      client.release();
    }
  }

  async findByIdempotency(
    workflowId: string,
    idempotencyKey: string,
  ): Promise<WorkflowExecutionRecord | undefined> {
    const client = await this.pool.connect();
    try {
      const response = await client.query<WorkflowLedgerRow>(
        `SELECT execution_id, workflow_id, idempotency_key, payload_hash,
                correlation_id, status, created_at, updated_at,
                provider_execution_id, output_json, safe_error_code
           FROM sofia_workflow_executions
          WHERE workflow_id = $1 AND idempotency_key = $2`,
        [workflowId, idempotencyKey],
      );
      return response.rows[0] ? fromRow(response.rows[0]) : undefined;
    } finally {
      client.release();
    }
  }
}
