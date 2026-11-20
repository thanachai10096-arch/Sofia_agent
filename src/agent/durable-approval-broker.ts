import type {
  ApprovalAuditRecord,
  ApprovalBrokerPort,
  ApprovalDecision,
  ApprovalHandler,
  PendingApproval,
} from "./approval.js";
import type { ApprovalPayloadCipher } from "./approval-payload-cipher.js";
import { DurableApprovalCoordinator, type DurableApprovalTicket } from "./durable-approval-coordinator.js";
import type { TransactionalApprovalStore } from "./sqlite-approval-store.js";
import { SqliteApprovalPayloadStore } from "./sqlite-approval-payload-store.js";

/**
 * ApprovalBrokerPort backed by same-host SQLite. The API process can list and
 * decide approvals created by another worker; only the origin worker awaits
 * the coordinator and resumes its own tool call.
 *
 * The encryption key must be supplied by the host from a stable secret store.
 * This class never persists or returns the key or encrypted envelope.
 */
export class DurableApprovalBroker implements ApprovalBrokerPort {
  constructor(
    private readonly approvals: TransactionalApprovalStore,
    private readonly payloads: SqliteApprovalPayloadStore,
    private readonly cipher: ApprovalPayloadCipher,
    private readonly coordinator: DurableApprovalCoordinator,
    private readonly now: () => number = Date.now,
  ) {}

  readonly handle: ApprovalHandler = async (request) => {
    const ticket = this.coordinator.create(request);
    if (!ticket) return false;
    try {
      const result = await this.coordinator.waitForDecision(ticket, request.principalId ?? "");
      return result.status === "approved";
    } finally {
      // The proposal is no longer needed after a terminal decision. A failed
      // cleanup is safe: it remains encrypted and cannot be read as pending.
      this.payloads.delete(ticket.id);
    }
  };

  pending(principalId: string): PendingApproval[] {
    const owner = principalId.trim();
    if (!owner) return [];
    return this.approvals.pending(owner, this.now()).flatMap((record) => {
      const ticket = this.ticket(record);
      const input = this.coordinator.readPending(ticket, owner);
      if (!input) return [];
      return [{
        id: record.id,
        runId: record.runId,
        principalId: record.principalId,
        toolName: record.toolName,
        input,
        actionHash: record.actionHash,
        risk: record.risk,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      }];
    });
  }

  history(principalId: string): ApprovalAuditRecord[] {
    const owner = principalId.trim();
    return owner ? this.approvals.history(owner).map((record) => ({ ...record })) : [];
  }

  decide(decision: ApprovalDecision): boolean {
    const owner = decision.principalId?.trim();
    if (!owner || !decision.approvalId || !decision.actionHash) return false;
    const record = this.approvals.get(owner, decision.approvalId, this.now());
    if (!record || record.status !== "pending" || record.actionHash !== decision.actionHash) return false;
    return this.approvals.settlePending(
      record.id,
      owner,
      record.actionHash,
      decision.approved === true ? "approved" : "rejected",
      this.now(),
    );
  }

  cancelRun(runId: string, principalId: string): number {
    const owner = principalId.trim();
    if (!runId || !owner) return 0;
    let cancelled = 0;
    for (const record of this.approvals.pending(owner, this.now())) {
      if (record.runId !== runId) continue;
      if (this.approvals.settlePending(record.id, owner, record.actionHash, "cancelled", this.now())) {
        cancelled++;
      }
    }
    return cancelled;
  }

  private ticket(record: ApprovalAuditRecord): DurableApprovalTicket {
    return {
      id: record.id,
      context: {
        approvalId: record.id,
        principalId: record.principalId,
        runId: record.runId,
        toolName: record.toolName,
        actionHash: record.actionHash,
        expiresAt: record.expiresAt,
      },
    };
  }
}
