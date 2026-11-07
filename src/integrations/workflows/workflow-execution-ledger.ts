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

/**
 * Atomically claim a reserved execution before making any external network call.
 *
 * The caller MUST dispatch only when this returns true. A false result means
 * another worker already claimed it or its state changed; do not send the
 * external request. A crash after this claim is intentionally treated as
 * ambiguous and must be reconciled rather than blindly dispatched again.
 */
export async function claimWorkflowExecutionForDispatch(
  ledger: WorkflowExecutionLedger,
  executionId: string,
): Promise<boolean> {
  const claimed = await ledger.update(executionId, "accepted", { status: "running" });
  return claimed !== undefined;
}

/** Terminal outcomes cannot be replayed as a fresh dispatch. An indeterminate
 * outcome may only be resolved by reconciliation, never reset to accepted. */
export function canTransitionWorkflowExecution(
  current: WorkflowExecutionState,
  next: WorkflowExecutionState,
): boolean {
  const transitions: Readonly<Record<WorkflowExecutionState, readonly WorkflowExecutionState[]>> = {
    accepted: ["running", "succeeded", "failed", "cancelled", "indeterminate"],
    running: ["succeeded", "failed", "cancelled", "indeterminate"],
    indeterminate: ["running", "succeeded", "failed", "cancelled"],
    succeeded: [],
    failed: [],
    cancelled: [],
  };
  return transitions[current].includes(next);
}
