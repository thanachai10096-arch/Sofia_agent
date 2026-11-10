import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ApprovalHandler, ApprovalRequest } from "./approval.js";
import { redactSecrets } from "../security/guard.js";

type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";
export interface ApprovalRecord {
  id: string;
  ownerId: string;
  runId: string;
  toolName: string;
  input: Record<string, unknown>;
  actionHash: string;
  risk: ApprovalRequest["risk"];
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  decidedBy?: string;
}
type SqliteDatabase = import("node:sqlite").DatabaseSync;

function privateFile(filePath: string): void {
  if (filePath === ":memory:" || process.platform === "win32") return;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Approval storage must be a regular file.");
  const mode = stat.mode & 0o777;
  const privateMode = mode & 0o600;
  if (mode !== privateMode) fs.chmodSync(filePath, privateMode);
}
function sameHash(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
function parseRecord(row: Record<string, unknown>): ApprovalRecord {
  const input = JSON.parse(String(row.input_json)) as Record<string, unknown>;
  return {
    id: String(row.id), ownerId: String(row.owner_id), runId: String(row.run_id),
    toolName: String(row.tool_name), input, actionHash: String(row.action_hash),
    risk: String(row.risk) as ApprovalRequest["risk"], status: String(row.status) as ApprovalStatus,
    createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
    ...(row.decided_at === null ? {} : { decidedAt: Number(row.decided_at) }),
    ...(row.decided_by === null ? {} : { decidedBy: String(row.decided_by) }),
  };
}

/**
 * Durable, owner-scoped approval inbox. A decision is an atomic one-time
 * transition bound to both the authenticated owner and the exact action hash.
 * Pending approvals never grant permission by themselves.
 */
export class SqliteApprovalQueue {
  private constructor(private readonly db: SqliteDatabase, private readonly filePath: string) {}

  static async open(filePath: string, options: { busyTimeoutMs?: number } = {}): Promise<SqliteApprovalQueue> {
    if (!path.isAbsolute(filePath) && filePath !== ":memory:") throw new Error("Approval database path must be absolute.");
    const absolute = filePath === ":memory:" ? filePath : path.resolve(filePath);
    if (absolute !== ":memory:") {
      fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
      try { const fd = fs.openSync(absolute, "wx", 0o600); fs.closeSync(fd); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      privateFile(absolute);
    }
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(absolute);
    try {
      const timeout = options.busyTimeoutMs ?? 5_000;
      if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60_000) throw new Error("Invalid approval database busy timeout.");
      db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA busy_timeout = " + timeout);
      db.exec(`
        CREATE TABLE IF NOT EXISTS approvals (
          id TEXT PRIMARY KEY NOT NULL,
          owner_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          input_json TEXT NOT NULL,
          action_hash TEXT NOT NULL,
          risk TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired','cancelled')),
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          decided_at INTEGER,
          decided_by TEXT
        );
        CREATE INDEX IF NOT EXISTS approvals_owner_status_idx ON approvals(owner_id,status,created_at);
        CREATE TABLE IF NOT EXISTS approval_audit (
          id TEXT PRIMARY KEY NOT NULL,
          approval_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          decision TEXT NOT NULL,
          decided_by TEXT NOT NULL,
          action_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
      // Existing databases may have been created before cancellation became a
      // terminal approval state. Rebuild only this table transactionally so
      // pending/decided rows and their audit history survive the migration.
      const approvalSchema = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='approvals'",
      ).get() as { sql?: string } | undefined;
      if (!approvalSchema?.sql?.includes("'cancelled'")) {
        db.exec("BEGIN IMMEDIATE");
        try {
          db.exec(`
            ALTER TABLE approvals RENAME TO approvals_before_cancelled_migration;
            CREATE TABLE approvals (
              id TEXT PRIMARY KEY NOT NULL,
              owner_id TEXT NOT NULL,
              run_id TEXT NOT NULL,
              tool_name TEXT NOT NULL,
              input_json TEXT NOT NULL,
              action_hash TEXT NOT NULL,
              risk TEXT NOT NULL,
              status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired','cancelled')),
              created_at INTEGER NOT NULL,
              expires_at INTEGER NOT NULL,
              decided_at INTEGER,
              decided_by TEXT
            );
            INSERT INTO approvals(id,owner_id,run_id,tool_name,input_json,action_hash,risk,status,created_at,expires_at,decided_at,decided_by)
            SELECT id,owner_id,run_id,tool_name,input_json,action_hash,risk,status,created_at,expires_at,decided_at,decided_by
            FROM approvals_before_cancelled_migration;
            DROP TABLE approvals_before_cancelled_migration;
            CREATE INDEX approvals_owner_status_idx ON approvals(owner_id,status,created_at);
          `);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
      privateFile(absolute);
      return new SqliteApprovalQueue(db, absolute);
    } catch (error) { db.close(); throw error; }
  }

  create(request: ApprovalRequest, options: { ttlMs?: number } = {}): ApprovalRecord {
    const ownerId = request.principalId?.trim();
    if (!ownerId || ownerId.length > 256) throw new Error("An authenticated approval owner is required.");
    if (!request.runId || request.runId.length > 256 || !request.toolName || request.toolName.length > 200) throw new Error("Invalid approval request.");
    if (!/^[a-f0-9]{64}$/i.test(request.actionHash)) throw new Error("Invalid approval action hash.");
    const ttl = options.ttlMs ?? 10 * 60_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 24 * 60 * 60_000) throw new Error("Approval TTL must be between 1 second and 24 hours.");
    const now = Date.now();
    const safeInput = redactSecrets(structuredClone(request.input)) as Record<string, unknown>;
    const requestId = request.requestId ?? randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new Error("Invalid approval request ID.");
    const record: ApprovalRecord = {
      id: requestId, ownerId, runId: request.runId, toolName: request.toolName,
      input: safeInput, actionHash: request.actionHash, risk: request.risk,
      status: "pending", createdAt: now, expiresAt: now + ttl,
    };
    this.db.prepare(`
      INSERT INTO approvals(id,owner_id,run_id,tool_name,input_json,action_hash,risk,status,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,'pending',?,?)
    `).run(record.id, record.ownerId, record.runId, record.toolName, JSON.stringify(record.input),
      record.actionHash, record.risk, record.createdAt, record.expiresAt);
    privateFile(this.filePath);
    return record;
  }

  list(ownerId: string, options: { limit?: number; includeResolved?: boolean } = {}): ApprovalRecord[] {
    if (!ownerId || ownerId.length > 256) return [];
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RangeError("Approval list limit must be between 1 and 200.");
    this.expirePending();
    const rows = options.includeResolved
      ? this.db.prepare("SELECT * FROM approvals WHERE owner_id=? ORDER BY created_at DESC LIMIT ?").all(ownerId, limit)
      : this.db.prepare("SELECT * FROM approvals WHERE owner_id=? AND status='pending' ORDER BY created_at ASC LIMIT ?").all(ownerId, limit);
    return (rows as Array<Record<string, unknown>>).map(parseRecord);
  }

  decide(input: { id: string; ownerId: string; decidedBy: string; actionHash: string; approved: boolean }): ApprovalRecord | undefined {
    if (!input.id || !input.ownerId || !input.decidedBy || input.decidedBy !== input.ownerId) return undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM approvals WHERE id=? AND owner_id=?").get(input.id, input.ownerId) as Record<string, unknown> | undefined;
      if (!row) { this.db.exec("COMMIT"); return undefined; }
      const record = parseRecord(row);
      const now = Date.now();
      if (record.status !== "pending" || record.expiresAt <= now || !sameHash(record.actionHash, input.actionHash)) {
        if (record.status === "pending" && record.expiresAt <= now) {
          const expired = this.db.prepare("UPDATE approvals SET status='expired',decided_at=?,decided_by='system:expiry' WHERE id=? AND owner_id=? AND status='pending'")
            .run(now, record.id, input.ownerId);
          if (Number(expired.changes) === 1) {
            this.db.prepare("INSERT INTO approval_audit(id,approval_id,owner_id,decision,decided_by,action_hash,created_at) VALUES(?,?,?,?,?,?,?)")
              .run(randomUUID(), record.id, input.ownerId, "expired", "system:expiry", record.actionHash, now);
          }
        }
        this.db.exec("COMMIT");
        return undefined;
      }
      const status: ApprovalStatus = input.approved ? "approved" : "rejected";
      const result = this.db.prepare("UPDATE approvals SET status=?,decided_at=?,decided_by=? WHERE id=? AND owner_id=? AND status='pending' AND action_hash=?")
        .run(status, now, input.decidedBy, record.id, input.ownerId, record.actionHash);
      if (Number(result.changes) !== 1) { this.db.exec("ROLLBACK"); return undefined; }
      this.db.prepare("INSERT INTO approval_audit(id,approval_id,owner_id,decision,decided_by,action_hash,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(randomUUID(), record.id, input.ownerId, status, input.decidedBy, record.actionHash, now);
      this.db.exec("COMMIT");
      privateFile(this.filePath);
      return { ...record, status, decidedAt: now, decidedBy: input.decidedBy };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  /** Atomically abandon a still-pending approval when its owning run is cancelled. */
  cancelPending(id: string, ownerId: string): ApprovalRecord | undefined {
    if (!id || !ownerId || ownerId.length > 256) return undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(
        "SELECT * FROM approvals WHERE id=? AND owner_id=? AND status='pending'",
      ).get(id, ownerId) as Record<string, unknown> | undefined;
      if (!row) { this.db.exec("COMMIT"); return undefined; }
      const record = parseRecord(row);
      const now = Date.now();
      const updated = this.db.prepare(
        "UPDATE approvals SET status='cancelled',decided_at=?,decided_by='system:run-cancelled' WHERE id=? AND owner_id=? AND status='pending'",
      ).run(now, id, ownerId);
      if (Number(updated.changes) !== 1) { this.db.exec("ROLLBACK"); return undefined; }
      this.db.prepare(
        "INSERT INTO approval_audit(id,approval_id,owner_id,decision,decided_by,action_hash,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(randomUUID(), id, ownerId, "cancelled", "system:run-cancelled", record.actionHash, now);
      this.db.exec("COMMIT");
      privateFile(this.filePath);
      return { ...record, status: "cancelled", decidedAt: now, decidedBy: "system:run-cancelled" };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Expire pending approvals for one interrupted run without deleting their audit history.
   * Approved/rejected decisions are immutable and are never rewritten by recovery.
   */
  expirePendingForRun(runId: string, ownerId: string): number {
    if (!runId || runId.length > 256 || !ownerId || ownerId.length > 256) return 0;
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const pending = this.db.prepare(
        "SELECT id,action_hash FROM approvals WHERE run_id=? AND owner_id=? AND status='pending'",
      ).all(runId, ownerId) as Array<{ id: string; action_hash: string }>;
      const update = this.db.prepare(
        "UPDATE approvals SET status='expired',decided_at=?,decided_by='system:run-interrupted' WHERE id=? AND owner_id=? AND status='pending'",
      );
      const audit = this.db.prepare(
        "INSERT INTO approval_audit(id,approval_id,owner_id,decision,decided_by,action_hash,created_at) VALUES(?,?,?,?,?,?,?)",
      );
      let expired = 0;
      for (const record of pending) {
        if (Number(update.run(now, record.id, ownerId).changes) !== 1) continue;
        audit.run(randomUUID(), record.id, ownerId, "interrupted", "system:run-interrupted", record.action_hash, now);
        expired += 1;
      }
      this.db.exec("COMMIT");
      if (expired > 0) privateFile(this.filePath);
      return expired;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(id: string, ownerId: string): ApprovalRecord | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id=? AND owner_id=?").get(id, ownerId) as Record<string, unknown> | undefined;
    return row ? parseRecord(row) : undefined;
  }

  private expirePending(): void {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const expired = this.db.prepare("SELECT id,owner_id,action_hash FROM approvals WHERE status='pending' AND expires_at<=?")
        .all(now) as Array<{ id: string; owner_id: string; action_hash: string }>;
      const update = this.db.prepare("UPDATE approvals SET status='expired',decided_at=?,decided_by='system:expiry' WHERE id=? AND status='pending'");
      const audit = this.db.prepare("INSERT INTO approval_audit(id,approval_id,owner_id,decision,decided_by,action_hash,created_at) VALUES(?,?,?,?,?,?,?)");
      for (const record of expired) {
        if (Number(update.run(now, record.id).changes) !== 1) continue;
        audit.run(randomUUID(), record.id, record.owner_id, "expired", "system:expiry", record.action_hash, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void { this.db.close(); }
}

/** Wait for a poll interval, or stop immediately when the caller cancels. */
function waitForApprovalPoll(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (!signal) return new Promise((resolve) => setTimeout(() => resolve(true), ms));
  return new Promise((resolve) => {
    const finish = (continued: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(continued);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal.addEventListener("abort", onAbort, { once: true });
    // Close the race where abort fires after the initial check but before listener registration.
    if (signal.aborted) onAbort();
  });
}

/** Waits for a user decision; timeout, cancellation, storage errors, and missing identity all deny. */
export function createQueuedApprovalHandler(queue: SqliteApprovalQueue, options: {
  ttlMs?: number;
  pollMs?: number;
  /** Called after durable creation; delivery failure must never auto-approve or cancel the request. */
  onCreated?: (record: ApprovalRecord, request: ApprovalRequest) => void | Promise<void>;
  onNotificationError?: () => void;
  /** Reports durable cancellation failures without changing the fail-closed execution result. */
  onCancellationError?: (error: unknown) => void;
} = {}): ApprovalHandler {
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const pollMs = options.pollMs ?? 500;
  if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 10_000) throw new Error("Approval poll interval must be between 100 and 10000ms.");
  return async (request) => {
    if (request.signal?.aborted) return false;
    let record: ApprovalRecord;
    try { record = queue.create(request, { ttlMs }); } catch { return false; }
    if (options.onCreated) {
      try { await options.onCreated(record, request); }
      catch {
        try { options.onNotificationError?.(); } catch { /* notification diagnostics must not affect approval state */ }
      }
    }
    if (request.signal?.aborted) {
      try { queue.cancelPending(record.id, record.ownerId); } catch (error) {
        try { options.onCancellationError?.(error); } catch { /* diagnostics must not affect the fail-closed result */ }
      }
      return false;
    }
    while (Date.now() < record.expiresAt) {
      if (request.signal?.aborted) {
        try { queue.cancelPending(record.id, record.ownerId); } catch (error) {
          try { options.onCancellationError?.(error); } catch { /* diagnostics must not affect the fail-closed result */ }
        }
        return false;
      }
      const current = queue.get(record.id, record.ownerId);
      if (!current) return false;
      if (current.status === "approved") return sameHash(current.actionHash, request.actionHash);
      if (current.status !== "pending") return false;
      const continued = await waitForApprovalPoll(
        Math.min(pollMs, Math.max(1, record.expiresAt - Date.now())),
        request.signal,
      );
      if (!continued) {
        if (request.signal?.aborted) {
          try { queue.cancelPending(record.id, record.ownerId); } catch (error) {
            try { options.onCancellationError?.(error); } catch { /* diagnostics must not affect the fail-closed result */ }
          }
        }
        return false;
      }
    }
    return false;
  };
}
