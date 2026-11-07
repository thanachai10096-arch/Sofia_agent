import assert from "node:assert/strict";
import test from "node:test";
import type {
  ReserveWorkflowExecution,
  WorkflowExecutionLedger,
  WorkflowExecutionRecord,
} from "../../../src/integrations/workflows/workflow-execution-ledger.js";
import {
  canTransitionWorkflowExecution,
  claimWorkflowExecutionForDispatch,
} from "../../../src/integrations/workflows/workflow-execution-ledger.js";
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
    if (expectedStatus === "indeterminate") throw new Error("workflow_reconciliation_required");
    return this.applyUpdate(executionId, expectedStatus, patch);
  }

  async reconcile(
    executionId: string,
    patch: Pick<WorkflowExecutionRecord, "status"> &
      Partial<Pick<WorkflowExecutionRecord, "providerExecutionId" | "output" | "safeErrorCode">>,
  ) {
    if (!["succeeded", "failed", "cancelled"].includes(patch.status)) {
      throw new Error("workflow_reconciliation_invalid_outcome");
    }
    return this.applyUpdate(executionId, "indeterminate", patch);
  }

  private async applyUpdate(
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

  async listForReconciliation(olderThan: string, limit: number) {
    const cutoff = new Date(olderThan).getTime();
    return [...this.records.values()]
      .filter((record) =>
        (record.status === "running" || record.status === "indeterminate") &&
        new Date(record.updatedAt).getTime() <= cutoff)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, limit)
      .map((record) => structuredClone(record));
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
    /workflow_reconciliation_required/,
  );
  await assert.rejects(
    ledger.update(
      reservation.record.executionId,
      "indeterminate",
      { status: "running" },
    ),
    /workflow_reconciliation_required/,
  );
  await assert.rejects(
    ledger.reconcile(reservation.record.executionId, { status: "running" }),
    /workflow_reconciliation_invalid_outcome/,
  );
  const resolved = await ledger.reconcile(
    reservation.record.executionId,
    { status: "succeeded", output: { recovered: true } },
  );
  assert.equal(resolved?.status, "succeeded");
  assert.deepEqual(resolved?.output, { recovered: true });
  assert.equal((await ledger.get(reservation.record.executionId))?.status, "succeeded");
});

test("only one concurrent worker can claim an accepted execution for dispatch", async () => {
  const ledger = new MemoryLedger();
  const reservation = await ledger.reserve(request);
  const results = await Promise.all([
    claimWorkflowExecutionForDispatch(ledger, reservation.record.executionId),
    claimWorkflowExecutionForDispatch(ledger, reservation.record.executionId),
  ]);

  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await ledger.get(reservation.record.executionId))?.status, "running");
});

test("reconciliation listing returns only stale ambiguous executions", async () => {
  const ledger = new MemoryLedger();
  const old = await ledger.reserve({ ...request, idempotencyKey: "old" });
  await ledger.update(old.record.executionId, "accepted", { status: "running" });
  const fresh = await ledger.reserve({ ...request, idempotencyKey: "fresh" });
  await ledger.update(fresh.record.executionId, "accepted", { status: "running" });
  const cutoff = new Date(Date.now() + 1_000).toISOString();

  const stale = await ledger.listForReconciliation(cutoff, 10);
  assert.deepEqual(stale.map((record) => record.executionId), [
    old.record.executionId,
    fresh.record.executionId,
  ]);
});
