import assert from "node:assert/strict";
import test from "node:test";
import type {
  ReserveWorkflowExecution,
  WorkflowExecutionLedger,
  WorkflowExecutionRecord,
} from "../../../src/integrations/workflows/workflow-execution-ledger.js";
import { canTransitionWorkflowExecution } from "../../../src/integrations/workflows/workflow-execution-ledger.js";
import type { WorkflowExecutionState } from "../../../src/integrations/workflows/workflow-engine.js";

/** Contract fixture only; production persistence must be supplied separately. */
class MemoryLedger implements WorkflowExecutionLedger {
  private readonly records = new Map<string, WorkflowExecutionRecord>();
  private readonly keys = new Map<string, string>();
  private sequence = 0;

  async reserve(input: ReserveWorkflowExecution) {
    const key = JSON.stringify([input.workflowId, input.idempotencyKey]);
    const currentId = this.keys.get(key);
    if (currentId) {
      const current = this.records.get(currentId)!;
      if (current.payloadHash !== input.payloadHash || current.correlationId !== input.correlationId) {
        throw new Error("workflow_idempotency_conflict");
      }
      return { kind: "existing" as const, record: structuredClone(current) };
    }
    const now = new Date().toISOString();
    const record: WorkflowExecutionRecord = {
      executionId: `ledger-execution-${++this.sequence}`,
      ...input,
      status: "accepted",
      createdAt: now,
      updatedAt: now,
    };
    this.keys.set(key, record.executionId);
    this.records.set(record.executionId, record);
    return { kind: "created" as const, record: structuredClone(record) };
  }

  async update(
    executionId: string,
    expectedStatus: WorkflowExecutionState,
    patch: Pick<WorkflowExecutionRecord, "status"> &
      Partial<Pick<WorkflowExecutionRecord, "providerExecutionId" | "output" | "safeErrorCode">>,
  ) {
    const current = this.records.get(executionId);
    if (!current || current.status !== expectedStatus) return undefined;
    if (!canTransitionWorkflowExecution(current.status, patch.status)) {
      throw new Error("workflow_execution_invalid_transition");
    }
    const updated = { ...current, ...structuredClone(patch), updatedAt: new Date().toISOString() };
    this.records.set(executionId, updated);
    return structuredClone(updated);
  }

  async get(executionId: string) {
    const record = this.records.get(executionId);
    return record ? structuredClone(record) : undefined;
  }

  async findByIdempotency(workflowId: string, idempotencyKey: string) {
    const id = this.keys.get(JSON.stringify([workflowId, idempotencyKey]));
    return id ? this.get(id) : undefined;
  }
}

const request = {
  workflowId: "daily-report",
  idempotencyKey: "telegram-update-77",
  payloadHash: "sha256:payload-a",
  correlationId: "corr-77",
};

test("ledger reserves once and returns the same record for duplicate requests", async () => {
  const ledger = new MemoryLedger();
  const [first, second] = await Promise.all([ledger.reserve(request), ledger.reserve(request)]);
  assert.equal(first.kind, "created");
  assert.equal(second.kind, "existing");
  assert.equal(first.record.executionId, second.record.executionId);
  assert.equal((await ledger.findByIdempotency(request.workflowId, request.idempotencyKey))?.status, "accepted");
});

test("ledger rejects idempotency-key reuse with a different payload or correlation ID", async () => {
  const ledger = new MemoryLedger();
  await ledger.reserve(request);
  await assert.rejects(
    ledger.reserve({ ...request, payloadHash: "sha256:payload-b" }),
    /workflow_idempotency_conflict/,
  );
  await assert.rejects(
    ledger.reserve({ ...request, correlationId: "other-correlation" }),
    /workflow_idempotency_conflict/,
  );
});

test("ledger update is compare-and-set and preserves indeterminate outcomes", async () => {
  const ledger = new MemoryLedger();
  const reservation = await ledger.reserve(request);
  const markedRunning = await ledger.update(
    reservation.record.executionId,
    "accepted",
    { status: "running" },
  );
  assert.equal(markedRunning?.status, "running");
  assert.equal(await ledger.update(
    reservation.record.executionId,
    "accepted",
    { status: "succeeded" },
  ), undefined);

  const indeterminate = await ledger.update(
    reservation.record.executionId,
    "running",
    { status: "indeterminate", safeErrorCode: "outcome_unknown" },
  );
  assert.equal(indeterminate?.status, "indeterminate");
  await assert.rejects(
    ledger.update(
      reservation.record.executionId,
      "indeterminate",
      { status: "accepted" },
    ),
    /workflow_execution_invalid_transition/,
  );
  assert.equal((await ledger.get(reservation.record.executionId))?.status, "indeterminate");
});
