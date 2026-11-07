import { randomUUID, timingSafeEqual } from "node:crypto";
import type { ApprovalRequest } from "../agent/approval.js";
import { redactSecrets } from "../security/guard.js";
import type { FileApprovalAuditStore } from "./approval-audit-store.js";

export interface ApprovalInboxItem {
  id: string;
  runId: string;
  toolName: string;
  input: Record<string, unknown>;
  actionHash: string;
  risk: ApprovalRequest["risk"];
  createdAt: number;
  expiresAt: number;
  status: "pending";
}

interface PendingApproval {
  item: ApprovalInboxItem;
  ownerId: string;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

/**
 * Owner-bound, one-shot approval inbox.
 * Decisions must echo the immutable action hash shown to the owner.
 * Pending approvals intentionally fail closed on process restart.
 */
export class ApprovalInbox {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly options: { ttlMs?: number; maxPendingPerOwner?: number; maxInputBytes?: number; auditStore?: FileApprovalAuditStore } = {},
  ) {}

  request: (request: ApprovalRequest) => Promise<boolean> = (request) => {
    const ownerId = request.principalId?.trim();
    if (!ownerId || !request.runId || !request.toolName || !/^[a-f0-9]{64}$/i.test(request.actionHash)) {
      return Promise.resolve(false);
    }
    const ttlMs = this.options.ttlMs ?? 120_000;
    const maxPending = this.options.maxPendingPerOwner ?? 30;
    const maxInputBytes = this.options.maxInputBytes ?? 32_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 10 * 60_000) return Promise.resolve(false);
    const count = [...this.pending.values()].filter((entry) => entry.ownerId === ownerId).length;
    if (count >= maxPending) return Promise.resolve(false);

    let input: Record<string, unknown>;
    try {
      const serialized = JSON.stringify(request.input);
      if (Buffer.byteLength(serialized, "utf8") > maxInputBytes) return Promise.resolve(false);
      input = JSON.parse(serialized) as Record<string, unknown>;
    } catch {
      return Promise.resolve(false);
    }

    const now = Date.now();
    const id = randomUUID();
    const item: ApprovalInboxItem = {
      id,
      runId: request.runId,
      toolName: request.toolName,
      input,
      actionHash: request.actionHash,
      risk: request.risk,
      createdAt: now,
      expiresAt: now + ttlMs,
      status: "pending",
    };

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const current = this.pending.get(id);
        if (!current) return;
        this.pending.delete(id);
        resolve(false);
      }, ttlMs);
      timer.unref?.();
      this.pending.set(id, { item, ownerId, resolve, timer });
    });
  };

  list(ownerId: string): Array<Omit<ApprovalInboxItem, "input" | "actionHash"> & { input: unknown; actionHash: string }> {
    const now = Date.now();
    return [...this.pending.values()]
      .filter((entry) => entry.ownerId === ownerId && entry.item.expiresAt > now)
      .map(({ item }) => ({
        ...item,
        input: redactSecrets(item.input),
      }));
  }

  decide(ownerId: string, id: string, actionHash: string, decision: "approve" | "deny"): boolean {
    const entry = this.pending.get(id);
    if (!entry || entry.ownerId !== ownerId) return false;
    if (entry.item.expiresAt <= Date.now()) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve(false);
      return false;
    }
    const expected = Buffer.from(entry.item.actionHash, "hex");
    const supplied = Buffer.from(actionHash, "hex");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false;

    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(decision === "approve");
    return true;
  }

  close(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve(false);
    }
  }
}
