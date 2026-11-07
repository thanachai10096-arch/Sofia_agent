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
   * Start an allowlisted workflow. Implementations must deduplicate repeated
   * requests by workflowId + idempotencyKey and must not treat a timeout as proof
   * that the external side effect did not happen. If cancellation occurs after
   * dispatch, report an indeterminate outcome unless non-execution is confirmed.
   */
  start(request: WorkflowStartRequest): Promise<WorkflowStartResult>;

  /** Return the current state for an execution owned by the calling Sofia context. */
  getStatus(executionId: string, signal?: AbortSignal): Promise<WorkflowStatusResult | undefined>;
}
