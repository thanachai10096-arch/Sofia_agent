import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkflowEngine,
  WorkflowStartRequest,
  WorkflowStartResult,
  WorkflowStatusResult,
} from "../../src/integrations/workflows/workflow-engine.js";

class FakeWorkflowEngine implements WorkflowEngine {
  private nextId = 1;
  private readonly executions = new Map<string, WorkflowStatusResult>();
  private readonly idempotency = new Map<string, string>();

  async start(request: WorkflowStartRequest): Promise<WorkflowStartResult> {
    request.signal?.throwIfAborted();
    const key = request.workflowId + ":" + request.idempotencyKey;
    const previousId = this.idempotency.get(key);
    if (previousId) {
      const previous = this.executions.get(previousId)!;
      return { executionId: previousId, status: previous.status as WorkflowStartResult["status"] };
    }
    const executionId = "fake-execution-" + this.nextId++;
    const result: WorkflowStatusResult = {
      executionId,
      workflowId: request.workflowId,
      status: "succeeded",
      output: structuredClone(request.input),
    };
    this.idempotency.set(key, executionId);
    this.executions.set(executionId, result);
    return { executionId, status: "succeeded" };
  }

  async getStatus(executionId: string, signal?: AbortSignal): Promise<WorkflowStatusResult | undefined> {
    signal?.throwIfAborted();
    const result = this.executions.get(executionId);
    return result ? structuredClone(result) : undefined;
  }
}

test("workflow engine contract returns an inspectable execution result", async () => {
  const engine = new FakeWorkflowEngine();
  const started = await engine.start({
    workflowId: "daily-report",
    input: { range: "today" },
    idempotencyKey: "message-123",
    correlationId: "corr-123",
  });
  assert.equal(started.status, "succeeded");
  const status = await engine.getStatus(started.executionId);
  assert.deepEqual(status, {
    executionId: started.executionId,
    workflowId: "daily-report",
    status: "succeeded",
    output: { range: "today" },
  });
});

test("workflow engine contract deduplicates repeated dispatches", async () => {
  const engine = new FakeWorkflowEngine();
  const request: WorkflowStartRequest = {
    workflowId: "daily-report",
    input: { range: "today" },
    idempotencyKey: "same-message",
    correlationId: "corr-456",
  };
  const first = await engine.start(request);
  const second = await engine.start(request);
  assert.equal(second.executionId, first.executionId);
  assert.equal(second.status, first.status);
});

test("workflow engine contract fails closed for pre-aborted requests", async () => {
  const engine = new FakeWorkflowEngine();
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(
    engine.start({
      workflowId: "daily-report",
      input: {},
      idempotencyKey: "aborted",
      correlationId: "corr-aborted",
      signal: controller.signal,
    }),
    /cancelled/,
  );
  assert.equal(await engine.getStatus("fake-execution-1"), undefined);
});

test("workflow engine contract returns undefined for unknown execution IDs", async () => {
  const engine = new FakeWorkflowEngine();
  assert.equal(await engine.getStatus("not-owned-or-found"), undefined);
});
