import fs from "node:fs";
import path from "node:path";
import type { ApprovalDecision, ApprovalDecisionStore, ApprovalRecord } from "./approval-broker.js";
import { sofiaStateDirectory } from "../platform/state-directory.js";

type SqliteDatabase = import("node:sqlite").DatabaseSync;

/**
 * SQLite-backed approval store for processes sharing the same SQLite-compatible
 * filesystem. Use a network database adapter for multi-host deployments where
 * the filesystem does not provide SQLite locking/WAL guarantees.
 */
export class SqliteApprovalDecisionStore implements ApprovalDecisionStore {
  private constructor(private readonly db: SqliteDatabase, private readonly filePath: string) {}

  static async open(filePath = path.join(sofiaStateDirectory("approvals"), "approvals.sqlite")): Promise<SqliteApprovalDecisionStore> {
    const absolutePath = filePath === ":memory:" ? filePath : path.resolve(filePath);
    if (absolutePath !== ":memory:") {
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
      try {
        const fd = fs.openSync(absolutePath, "wx", 0o600);
        fs.closeSync(fd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      restrictFilePermissions(absolutePath);
    }
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(absolutePath);
    try {
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
      restrictSqlitePermissions(absolutePath);
      const store = new SqliteApprovalDecisionStore(db, absolutePath);
      store.migrate();
      restrictSqlitePermissions(absolutePath);
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private migrate(): void {
    // Re-check the schema version after acquiring the write lock. Multiple
    // replicas may open the same database simultaneously during deployment.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
      if (version > 1) throw new Error(`Approval database schema version ${version} is newer than this Sofia Agent supports.`);
      if (version === 0) {
        this.db.exec(`
          CREATE TABLE approval_requests (
            id TEXT PRIMARY KEY NOT NULL,
            run_id TEXT NOT NULL,
            principal_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            input_json TEXT NOT NULL,
            action_hash TEXT NOT NULL,
            risk TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired','cancelled')),
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            resolved_at INTEGER,
            resolved_by TEXT
          );
          CREATE INDEX approval_pending_owner_idx ON approval_requests(principal_id, status, created_at);
          CREATE INDEX approval_expiry_idx ON approval_requests(status, expires_at);
          PRAGMA user_version = 1;
        `);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async create(record: ApprovalRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO approval_requests
      (id, run_id, principal_id, tool_name, input_json, action_hash, risk, status, created_at, expires_at, resolved_at, resolved_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.runId, record.principalId, record.toolName, JSON.stringify(record.input),
      record.actionHash, record.risk, record.status, record.createdAt, record.expiresAt,
      record.resolvedAt ?? null, record.resolvedBy ?? null,
    );
    restrictSqlitePermissions(this.filePath);
  }

  async get(id: string): Promise<ApprovalRecord | undefined> {
    const row = this.db.prepare("SELECT * FROM approval_requests WHERE id = ?").get(id) as ApprovalRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  async listPending(principalId: string): Promise<ApprovalRecord[]> {
    if (!principalId.trim()) return [];
    const now = Date.now();
    this.db.prepare(`
      UPDATE approval_requests
      SET status = 'expired', resolved_at = ?, resolved_by = 'system:expiry'
      WHERE status = 'pending' AND expires_at <= ?
    `).run(now, now);
    const rows = this.db.prepare(
      "SELECT * FROM approval_requests WHERE status = 'pending' AND principal_id = ? ORDER BY created_at ASC, id ASC LIMIT 200",
    ).all(principalId) as ApprovalRow[];
    restrictSqlitePermissions(this.filePath);
    return rows.map(fromRow);
  }

  async resolve(id: string, actionHash: string, decision: ApprovalDecision, resolvedBy: string, now: number): Promise<boolean> {
    const expire = this.db.prepare(`
      UPDATE approval_requests
      SET status = 'expired', resolved_at = ?, resolved_by = 'system:expiry'
      WHERE id = ? AND status = 'pending' AND action_hash = ? AND expires_at <= ?
    `).run(now, id, actionHash, now);
    if (Number(expire.changes) > 0) {
      restrictSqlitePermissions(this.filePath);
      return decision === "expired";
    }
    if (decision === "expired") return false;
    const result = this.db.prepare(`
      UPDATE approval_requests
      SET status = ?, resolved_at = ?, resolved_by = ?
      WHERE id = ? AND status = 'pending' AND action_hash = ? AND expires_at > ?
    `).run(decision, now, resolvedBy, id, actionHash, now);
    restrictSqlitePermissions(this.filePath);
    return Number(result.changes) === 1;
  }

  close(): void { this.db.close(); }
}

interface ApprovalRow {
  id: string; run_id: string; principal_id: string; tool_name: string; input_json: string;
  action_hash: string; risk: string; status: ApprovalRecord["status"]; created_at: number;
  expires_at: number; resolved_at: number | null; resolved_by: string | null;
}

function fromRow(row: ApprovalRow): ApprovalRecord {
  const input: unknown = JSON.parse(row.input_json);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Stored approval input is invalid.");
  return {
    id: row.id, runId: row.run_id, principalId: row.principal_id, toolName: row.tool_name,
    input: input as Record<string, unknown>, actionHash: row.action_hash, risk: row.risk as ApprovalRecord["risk"],
    status: row.status, createdAt: row.created_at, expiresAt: row.expires_at,
    ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
    ...(row.resolved_by !== null ? { resolvedBy: row.resolved_by } : {}),
  };
}

function restrictFilePermissions(filePath: string): void {
  if (process.platform === "win32" || filePath === ":memory:") return;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Approval storage paths must be regular files.");
    const mode = stat.mode & 0o777;
    const privateMode = mode & 0o600;
    if (mode !== privateMode) fs.chmodSync(filePath, privateMode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function restrictSqlitePermissions(filePath: string): void {
  if (filePath === ":memory:" || process.platform === "win32") return;
  restrictFilePermissions(filePath);
  restrictFilePermissions(filePath + "-wal");
  restrictFilePermissions(filePath + "-shm");
}
