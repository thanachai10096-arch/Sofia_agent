import { randomUUID } from "node:crypto";
import type { RiskLevel } from "../security/guard.js";
import type { ApprovalAuditRecord, ApprovalAuditStatus, ApprovalRequest } from "./approval.js";
import type { ApprovalPayloadCipher, ApprovalPayloadContext } from "./approval-payload-cipher.js";
import type { TransactionalApprovalStore } from "./sqlite-approval-store.js";
import { SqliteApprovalPayloadStore } from "./sqlite-approval-payload-store.js";

export interface DurableApprovalTicket {
  id: string;
  context: ApprovalPayloadContext;
}

export interface DurableApprovalResult {
  status: Exclude<ApprovalAuditStatus, "pending">;
  input?: Record<string, unknown>;
}

export interface DurableApprovalCoordinatorOptions {
  ttlMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const terminal = new Set<ApprovalAuditStatus>([
  "approved", "rejected", "expired", "cancelled", "interrupted",
]);

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Approval wait aborted."));
      return;
    }
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Approval wait aborted."));
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Same-host durable approval handoff. The creating worker remains the executor:
 * this class only persists the encrypted proposal, observes a terminal decision,
 * and returns the authenticated input to that original worker.
 *
 * The metadata and payload stores currently use separate SQLite connections, so
 * creation is compensated (never left actionable) if encrypted-payload storage
 * fails. This is not a cross-host broker or a distributed worker lease.
 */
export class DurableApprovalCoordinator {
  private readonly ttlMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private readonly approvals: TransactionalApprovalStore,
    private readonly payloads: SqliteApprovalPayloadStore,
    private readonly cipher: ApprovalPayloadCipher,
    options: DurableApprovalCoordinatorOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 120_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1_000 || this.ttlMs > 15 * 60_000) {
      throw new RangeError("Durable approval TTL must be between 1 second and 15 minutes.");
    }
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 50 || this.pollIntervalMs > 5_000) {
      throw new RangeError("Approval polling interval must be between 50ms and 5 seconds.");
    }
  }

  create(request: ApprovalRequest): DurableApprovalTicket | null {
    const principalId = request.principalId?.trim();
    if (!principalId || !request.runId?.trim() || !request.toolName?.trim() ||
        !request.actionHash?.trim() || !request.input || typeof request.input !== "object" ||
        Array.isArray(request.input)) return null;

    const createdAt = this.now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) return null;
    const id = randomUUID();
    const expiresAt = createdAt + this.ttlMs;
    const record: ApprovalAuditRecord = {
      id, runId: request.runId, principalId, toolName: request.toolName,
      actionHash: request.actionHash, risk: request.risk as RiskLevel,
      status: "pending", createdAt, expiresAt,
    };
    const context: ApprovalPayloadContext = {
      approvalId: id, principalId, runId: request.runId, toolName: request.toolName,
      actionHash: request.actionHash, expiresAt,
    };

    if (!this.approvals.createPending(record)) return null;
    let serialized: string;
    try {
      serialized = JSON.stringify(request.input);
      if (typeof serialized !== "string") throw new Error("Approval input is not serializable.");
    } catch {
      this.approvals.settlePending(id, principalId, request.actionHash, "interrupted", this.now());
      return null;
    }
    if (!this.payloads.save(serialized, context, this.cipher, this.now())) {
      // A metadata-only pending row must never be presented as an actionable approval.
      this.approvals.settlePending(id, principalId, request.actionHash, "interrupted", this.now());
      return null;
    }
    return { id, context };
  }

  /** Reviewer-side, owner-scoped read. The encrypted envelope never leaves the store. */
  readPending(ticket: DurableApprovalTicket, principalId: string): Record<string, unknown> | null {
    const owner = principalId.trim();
    if (!owner || owner !== ticket.context.principalId || ticket.id !== ticket.context.approvalId) return null;
    const record = this.approvals.get(owner, ticket.id, this.now());
    if (!record || record.status !== "pending" || !this.matches(record, ticket.context)) return null;
    return this.decode(ticket.context, this.payloads.load(ticket.context, this.cipher, this.now()));
  }

  /** Wait only for this owner's exact approval; only the originating worker gets the action back. */
  async waitForDecision(
    ticket: DurableApprovalTicket,
    principalId: string,
    signal?: AbortSignal,
  ): Promise<DurableApprovalResult> {
    const owner = principalId.trim();
    if (!owner || owner !== ticket.context.principalId || ticket.id !== ticket.context.approvalId) {
      return { status: "interrupted" };
    }
    for (;;) {
      if (signal?.aborted) return { status: "interrupted" };
      const now = this.now();
      const record = this.approvals.get(owner, ticket.id, now);
      if (!record || !this.matches(record, ticket.context)) return { status: "interrupted" };
      if (terminal.has(record.status)) {
        if (record.status !== "approved") return { status: record.status as Exclude<ApprovalAuditStatus, "pending"> };
        const input = this.decode(ticket.context, this.payloads.load(ticket.context, this.cipher, now));
        return input ? { status: "approved", input } : { status: "interrupted" };
      }
      const remaining = ticket.context.expiresAt - now;
      if (remaining <= 0) return { status: "expired" };
      try {
        await this.sleep(Math.min(this.pollIntervalMs, remaining), signal);
      } catch {
        return { status: "interrupted" };
      }
    }
  }

  private matches(record: ApprovalAuditRecord, context: ApprovalPayloadContext): boolean {
    return record.id === context.approvalId && record.principalId === context.principalId &&
      record.runId === context.runId && record.toolName === context.toolName &&
      record.actionHash === context.actionHash && record.expiresAt === context.expiresAt;
  }

  private decode(context: ApprovalPayloadContext, serialized: string | null): Record<string, unknown> | null {
    if (serialized === null) return null;
    try {
      const value: unknown = JSON.parse(serialized);
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      return value as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
