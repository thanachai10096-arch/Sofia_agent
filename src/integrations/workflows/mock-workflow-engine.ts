import type {
  WorkflowEngine,
  WorkflowStartRequest,
  WorkflowStartResult,
  WorkflowStatusResult,
} from "./workflow-engine.js";

export type MockWorkflowHandler = (
  input: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
) => Promise<unknown>;

export interface MockWorkflowEngineOptions {
  /** Explicitly registered workflows. Unknown IDs are rejected. */
  readonly workflows: ReadonlyMap<string, MockWorkflowHandler>;
  readonly createExecutionId?: (sequence: number) => string;
}

/**
 * In-memory test/development engine. It performs no network I/O and is not
 * suitable for production durability or cross-process idempotency.
 */
export class MockWorkflowEngine implements WorkflowEngine {
  private sequence = 0;
  private readonly executions = new Map<string, WorkflowStatusResult>();
  private readonly idempotency = new Map<string, Promise<WorkflowStartResult>>();

  constructor(private readonly options: MockWorkflowEngineOptions) {}

  async start(request: WorkflowStartRequest): Promise<WorkflowStartResult> {
    request.signal?.throwIfAborted();

    const handler = this.options.workflows.get(request.workflowId);
    if (!handler) {
      throw new Error("workflow_not_allowlisted");
    }
    if (!request.idempotencyKey.trim() || !request.correlationId.trim()) {
      throw new Error("workflow_request_identity_required");
    }

    const key = JSON.stringify([request.workflowId, request.idempotencyKey]);
    const existing = this.idempotency.get(key);
    if (existing) return existing;

    const executionId = (this.options.createExecutionId ?? ((n) => `mock-execution-${n}`))(++this.sequence);
    const pending = this.execute(executionId, request, handler);
    // Store the promise before awaiting so concurrent duplicate starts share it.
    this.idempotency.set(key, pending);
    return pending;
  }

  async getStatus(executionId: string, signal?: AbortSignal): Promise<WorkflowStatusResult | undefined> {
    signal?.throwIfAborted();
    const result = this.executions.get(executionId);
    return result ? structuredClone(result) : undefined;
  }

  private async execute(
    executionId: string,
    request: WorkflowStartRequest,
    handler: MockWorkflowHandler,
  ): Promise<WorkflowStartResult> {
    this.executions.set(executionId, {
      executionId,
      workflowId: request.workflowId,
      status: "running",
    });

    try {
      request.signal?.throwIfAborted();
      const output = await handler(structuredClone(request.input), request.signal);
      request.signal?.throwIfAborted();
      this.executions.set(executionId, {
        executionId,
        workflowId: request.workflowId,
        status: "succeeded",
        output: output === undefined ? undefined : structuredClone(output),
      });
      return { executionId, status: "succeeded" };
    } catch (error) {
      const cancelled = request.signal?.aborted === true;
      this.executions.set(executionId, {
        executionId,
        workflowId: request.workflowId,
        status: cancelled ? "cancelled" : "failed",
        safeErrorCode: cancelled ? "cancelled" : "mock_workflow_failed",
      });
      throw error;
    }
  }
}
