import type { WorkflowExecutionState } from "./workflow-engine.js";

/**
 * Durable record for one external workflow dispatch.
 *
 * Implementations must provide atomic uniqueness on (workflowId, idempotencyKey)
 * across all workers that share the store. A process-local Map is not sufficient.
 * Persist the reservation before any network dispatch.
 */
export interface WorkflowExecutionRecord {
  readonly executionId: string;
  readonly workflowId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly correlationId: string;
  readonly status: WorkflowExecutionState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly providerExecutionId?: string;
  readonly output?: unknown;
  readonly safeErrorCode?: string;
}

export interface ReserveWorkflowExecution {
  readonly workflowId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly correlationId: string;
}

export type WorkflowReservation =
  | { readonly kind: "created"; readonly record: WorkflowExecutionRecord }
  | { readonly kind: "existing"; readonly record: WorkflowExecutionRecord };

/**
 * Persistence boundary for external workflow dispatch.
 *
 * reserve() must atomically create a "accepted" record or return the existing
 * record. Reusing the same key with a different payload hash or correlation ID
 * must fail with workflow_idempotency_conflict.
 *
 * update() must be an atomic compare-and-set against expectedStatus. In
 * particular, an ambiguous dispatch must be stored as "indeterminate" and
 * must never be silently reset to "accepted" for an automatic retry.
 */
export interface WorkflowExecutionLedger {
  reserve(input: ReserveWorkflowExecution): Promise<WorkflowReservation>;
  update(
    executionId: string,
    expectedStatus: WorkflowExecutionState,
    patch: Pick<WorkflowExecutionRecord, "status"> &
      Partial<Pick<WorkflowExecutionRecord, "providerExecutionId" | "output" | "safeErrorCode">>,
  ): Promise<WorkflowExecutionRecord | undefined>;
  get(executionId: string): Promise<WorkflowExecutionRecord | undefined>;
  findByIdempotency(
    workflowId: string,
    idempotencyKey: string,
  ): Promise<WorkflowExecutionRecord | undefined>;
}
