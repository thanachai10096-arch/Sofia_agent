import { randomUUID } from "node:crypto";
import { redactSecrets } from "./guard.js";
import type { SecurityAuditEvent, SecurityAuditSink } from "./audit.js";
import type { IncompleteAuditExecution } from "./persistent-audit.js";

export type ExecutionReconciliationOutcome = "confirmed_completed" | "confirmed_not_applied";

export interface ExecutionRecoveryStore extends SecurityAuditSink {
  listIncompleteExecutions(): Promise<IncompleteAuditExecution[]>;
  recordReconciliation(event: SecurityAuditEvent): Promise<void>;
}

export type ExecutionReconciliationRequest = {
  operationId: string;
  outcome: ExecutionReconciliationOutcome;
  /** Authenticated operator identity supplied by the calling admin surface. */
  reconciledBy: string;
  /** Human-readable explanation of the external verification performed. */
  note: string;
};

/**
 * Read-only crash inspection plus explicit, auditable manual reconciliation.
 * This manager never invokes tools, retries operations, or resumes side effects.
 */
export class ExecutionRecoveryManager {
  constructor(private readonly store: ExecutionRecoveryStore) {}

  inspect(): Promise<IncompleteAuditExecution[]> {
    return this.store.listIncompleteExecutions();
  }

  async reconcile(request: ExecutionReconciliationRequest): Promise<SecurityAuditEvent> {
    const operationId = request.operationId?.trim();
    const reconciledBy = request.reconciledBy?.trim();
    const note = request.note?.trim();
    if (!operationId || operationId.length > 256) throw new Error("A valid operationId is required.");
    if (!reconciledBy || reconciledBy.length > 256) throw new Error("An authenticated reconciledBy identity is required.");
    if (!note || note.length > 2000) throw new Error("A reconciliation note between 1 and 2000 characters is required.");
    if (request.outcome !== "confirmed_completed" && request.outcome !== "confirmed_not_applied") {
      throw new Error("Unsupported reconciliation outcome.");
    }

    const pending = await this.store.listIncompleteExecutions();
    const execution = pending.find(item => item.operationId === operationId);
    if (!execution) throw new Error("Operation is not awaiting reconciliation.");

    const event: SecurityAuditEvent = {
      id: randomUUID(),
      at: new Date().toISOString(),
      runId: execution.started.runId,
      principalId: execution.started.principalId,
      toolName: execution.started.toolName,
      actionHash: execution.started.actionHash,
      risk: execution.started.risk,
      decision: "reconciled",
      operationId,
      reason: "Manual execution reconciliation",
      reconciliation: {
        outcome: request.outcome,
        reconciledBy: String(redactSecrets(reconciledBy)),
        note: String(redactSecrets(note)),
      },
    };
    await this.store.recordReconciliation(event);
    return event;
  }
}
