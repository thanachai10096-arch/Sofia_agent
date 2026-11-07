import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ApprovalHandler, ApprovalRequest } from "./approval.js";
import { redactSecrets } from "../security/guard.js";

type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
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
          status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired')),
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
    const record: ApprovalRecord = {
      id: randomUUID(), ownerId, runId: request.runId, toolName: request.toolName,
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
          this.db.prepare("UPDATE approvals SET status='expired',decided_at=? WHERE id=? AND status='pending'").run(now, record.id);
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

  get(id: string, ownerId: string): ApprovalRecord | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id=? AND owner_id=?").get(id, ownerId) as Record<string, unknown> | undefined;
    return row ? parseRecord(row) : undefined;
  }

  private expirePending(): void {
    this.db.prepare("UPDATE approvals SET status='expired',decided_at=? WHERE status='pending' AND expires_at<=?")
      .run(Date.now(), Date.now());
  }

  close(): void { this.db.close(); }
}

/** Waits for a user decision; timeout, storage errors, and missing identity all deny. */
export function createQueuedApprovalHandler(queue: SqliteApprovalQueue, options: { ttlMs?: number; pollMs?: number } = {}): ApprovalHandler {
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const pollMs = options.pollMs ?? 500;
  if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 10_000) throw new Error("Approval poll interval must be between 100 and 10000ms.");
  return async (request) => {
    let record: ApprovalRecord;
    try { record = queue.create(request, { ttlMs }); } catch { return false; }
    while (Date.now() < record.expiresAt) {
      const current = queue.get(record.id, record.ownerId);
      if (!current) return false;
      if (current.status === "approved") return sameHash(current.actionHash, request.actionHash);
      if (current.status !== "pending") return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, record.expiresAt - Date.now()))));
    }
    return false;
  };
}
