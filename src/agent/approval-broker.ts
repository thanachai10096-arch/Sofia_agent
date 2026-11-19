import { randomUUID } from "node:crypto";
import { redactSecrets, type RiskLevel } from "../security/guard.js";

export interface ApprovalRequest {
  runId: string;
  principalId?: string;
  toolName: string;
  input: Record<string, unknown>;
  actionHash: string;
  risk: RiskLevel;
  signal?: AbortSignal;
}

export type ApprovalDecision = "approved" | "denied" | "expired" | "cancelled";

export const MAX_PENDING_APPROVALS_PER_PRINCIPAL = 50;
export const MAX_APPROVAL_INPUT_BYTES = 64 * 1024;
export interface ApprovalRecord {
  id: string;
  runId: string;
  principalId: string;
  toolName: string;
  input: Record<string, unknown>;
  actionHash: string;
  risk: RiskLevel;
  status: "pending" | ApprovalDecision;
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number;
  resolvedBy?: string;
}

/**
 * Implementations must make create() unique by id and resolve() an atomic
 * compare-and-set from pending, checking the supplied actionHash.
 * Use SQLite for a single host or Upstash Redis for shared multi-replica deployments.
 */
export interface ApprovalDecisionStore {
  create(record: ApprovalRecord): Promise<void>;
  get(id: string): Promise<ApprovalRecord | undefined>;
  listPending(principalId: string): Promise<ApprovalRecord[]>;
  resolve(id: string, actionHash: string, decision: ApprovalDecision, resolvedBy: string, now: number): Promise<boolean>;
}

export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;

function waitForNextPoll(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function copy(record: ApprovalRecord): ApprovalRecord {
  return structuredClone(record);
}

export class InMemoryApprovalDecisionStore implements ApprovalDecisionStore {
  private readonly records = new Map<string, ApprovalRecord>();

  async create(record: ApprovalRecord): Promise<void> {
    if (this.records.has(record.id)) throw new Error("Approval request already exists.");
    for (const current of this.records.values()) {
      if (current.principalId === record.principalId && current.status === "pending" && current.expiresAt <= record.createdAt) {
        current.status = "expired";
        current.resolvedAt = record.createdAt;
        current.resolvedBy = "system:expiry";
      }
    }
    const pending = [...this.records.values()].filter((current) =>
      current.principalId === record.principalId && current.status === "pending",
    ).length;
    if (pending >= MAX_PENDING_APPROVALS_PER_PRINCIPAL) {
      throw new Error("Too many pending approval requests for this principal.");
    }
    this.records.set(record.id, copy(record));
  }

  async get(id: string): Promise<ApprovalRecord | undefined> {
    const record = this.records.get(id);
    return record ? copy(record) : undefined;
  }

  async listPending(principalId: string): Promise<ApprovalRecord[]> {
    if (!principalId.trim()) return [];
    return [...this.records.values()]
      .filter((record) => record.status === "pending" && (!principalId || record.principalId === principalId))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(copy);
  }

  async resolve(id: string, actionHash: string, decision: ApprovalDecision, resolvedBy: string, now: number): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || record.status !== "pending" || record.actionHash !== actionHash) return false;
    if (now >= record.expiresAt) {
      record.status = "expired";
      record.resolvedAt = now;
      record.resolvedBy = "system:expiry";
      return decision === "expired";
    }
    if (decision === "expired") return false;
    record.status = decision;
    record.resolvedAt = now;
    record.resolvedBy = resolvedBy;
    return true;
  }
}

export interface ApprovalBrokerOptions {
  store: ApprovalDecisionStore;
  ttlMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
}

export class ApprovalBroker {
  private readonly ttlMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ApprovalBrokerOptions) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1_000 || this.ttlMs > 24 * 60 * 60_000) {
      throw new Error("Approval TTL must be between 1000ms and 24 hours.");
    }
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 25 || this.pollIntervalMs > 10_000) {
      throw new Error("Approval poll interval must be between 25ms and 10000ms.");
    }
  }

  /** Compatible with AgentDependencies.approval; callers can bind this method. */
  readonly handle: ApprovalHandler = async (request) => {
    const principalId = request.principalId?.trim();
    if (!principalId || !request.runId.trim() || !request.toolName.trim() || !request.actionHash.trim()) return false;
    if (request.signal?.aborted) return false;

    const safeInput = redactSecrets(structuredClone(request.input)) as Record<string, unknown>;
    let inputBytes: number;
    try { inputBytes = Buffer.byteLength(JSON.stringify(safeInput), "utf8"); }
    catch { throw new Error("Approval input must be JSON-serializable."); }
    if (inputBytes > MAX_APPROVAL_INPUT_BYTES) throw new Error("Approval input exceeds the 64 KiB limit.");

    const createdAt = this.now();
    const record: ApprovalRecord = {
      id: randomUUID(),
      runId: request.runId,
      principalId,
      toolName: request.toolName,
      input: safeInput,
      actionHash: request.actionHash,
      risk: request.risk,
      status: "pending",
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    await this.options.store.create(record);

    while (!request.signal?.aborted) {
      const current = await this.options.store.get(record.id);
      if (!current) return false;
      if (current.status === "approved") return current.actionHash === request.actionHash;
      if (current.status !== "pending") return false;
      if (this.now() >= current.expiresAt) {
        await this.options.store.resolve(current.id, current.actionHash, "expired", "system:expiry", this.now());
        return false;
      }
      await waitForNextPoll(Math.min(this.pollIntervalMs, Math.max(1, current.expiresAt - this.now())), request.signal);
    }

    await this.options.store.resolve(record.id, record.actionHash, "cancelled", "system:abort", this.now());
    return false;
  };

  listPending(principalId: string): Promise<ApprovalRecord[]> {
    if (!principalId.trim()) return Promise.resolve([]);
    return this.options.store.listPending(principalId);
  }

  /** Cancel pending approvals tied to a run that cannot be resumed after restart. */
  async cancelRun(runId: string, principalId: string): Promise<number> {
    const run = runId.trim();
    const owner = principalId.trim();
    if (!run || run.length > 256 || !owner || owner.length > 256) return 0;
    const pending = await this.options.store.listPending(owner);
    let cancelled = 0;
    for (const record of pending) {
      if (record.principalId !== owner || record.runId !== run || record.status !== "pending") continue;
      if (await this.options.store.resolve(record.id, record.actionHash, "cancelled", "system:abort", this.now())) cancelled += 1;
    }
    return cancelled;
  }

  get(id: string): Promise<ApprovalRecord | undefined> {
    if (!id.trim()) return Promise.resolve(undefined);
    return this.options.store.get(id);
  }

  /** Resolve exactly the action hash shown to the approver; replay is rejected. */
  approve(id: string, actionHash: string, approverId: string): Promise<boolean> {
    return this.resolve(id, actionHash, "approved", approverId);
  }

  deny(id: string, actionHash: string, approverId: string): Promise<boolean> {
    return this.resolve(id, actionHash, "denied", approverId);
  }

  private async resolve(id: string, actionHash: string, decision: ApprovalDecision, approverId: string): Promise<boolean> {
    if (!id.trim() || !actionHash.trim() || !approverId.trim() || approverId.length > 256) return false;
    const record = await this.options.store.get(id);
    if (!record || record.principalId !== approverId) return false;
    return this.options.store.resolve(id, actionHash, decision, approverId, this.now());
  }
}
