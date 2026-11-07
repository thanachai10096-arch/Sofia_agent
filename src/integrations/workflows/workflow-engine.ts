export type WorkflowExecutionState =
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "indeterminate";

export interface WorkflowStartRequest {
  readonly workflowId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
}

export interface WorkflowStartResult {
  readonly executionId: string;
  readonly status: "accepted" | "running" | "succeeded" | "failed";
}

export interface WorkflowStatusResult {
  readonly executionId: string;
  readonly workflowId: string;
  readonly status: WorkflowExecutionState;
  readonly output?: unknown;
  /** Stable, non-sensitive category; never include provider messages or secrets. */
  readonly safeErrorCode?: string;
}

export interface WorkflowEngine {
  /**
   * Start an allowlisted workflow. Implementations must reserve a durable
   * idempotency record, then atomically claim accepted -> running BEFORE the
   * external network call. Only the worker that wins that compare-and-set may
   * dispatch. Existing running/indeterminate records must be reconciled, never
   * blindly dispatched again. A crash after the claim is ambiguous even if the
   * request may not yet have left the process.
   *
   * Implementations must not treat a timeout as proof that the external side
   * effect did not happen. If cancellation occurs after the claim, report an
   * indeterminate outcome unless non-execution is confirmed.
   */
  start(request: WorkflowStartRequest): Promise<WorkflowStartResult>;

  /** Return the current state for an execution owned by the calling Sofia context. */
  getStatus(executionId: string, signal?: AbortSignal): Promise<WorkflowStatusResult | undefined>;
}
