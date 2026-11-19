import fs from "node:fs";
import path from "node:path";
import type { RiskLevel } from "../security/guard.js";
import type { ApprovalAuditRecord, ApprovalAuditStatus } from "./approval.js";

export interface TransactionalApprovalStore {
  createPending(record: ApprovalAuditRecord): boolean;
  settlePending(
    id: string,
    principalId: string,
    actionHash: string,
    status: Exclude<ApprovalAuditStatus, "pending">,
    settledAt: number,
  ): boolean;
  expirePending(now: number): number;
  pending(principalId: string, now?: number): ApprovalAuditRecord[];
  history(principalId: string, limit?: number): ApprovalAuditRecord[];
}

type SqliteDatabase = import("node:sqlite").DatabaseSync;

/**
 * Transactional approval metadata store for multiple processes sharing one
 * local SQLite database. SQLite WAL is not a distributed/multi-host database:
 * do not place this file on an arbitrary network filesystem.
 *
 * Only action metadata is persisted. Proposed tool input and credentials are
 * deliberately excluded. A conditional UPDATE makes each decision single-use.
 */
export class SqliteApprovalStore implements TransactionalApprovalStore {
  private constructor(private readonly db: SqliteDatabase, private readonly filePath: string) {}

  static async open(filePath: string): Promise<SqliteApprovalStore> {
    if (!filePath.trim()) throw new Error("Approval database path must not be empty.");
    const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
    if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 5)) {
      throw new Error("SqliteApprovalStore requires Node.js 22.5 or newer (node:sqlite).");
    }
    const inMemory = filePath === ":memory:";
    const absolutePath = inMemory ? ":memory:" : path.resolve(filePath);
    if (!inMemory) {
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
      try {
        const stat = fs.lstatSync(absolutePath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error("Approval database path must be a regular file, not a symbolic link.");
        }
        if (process.platform !== "win32") fs.chmodSync(absolutePath, stat.mode & 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const fd = fs.openSync(absolutePath, "wx", 0o600);
        fs.closeSync(fd);
      }
    }

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(absolutePath);
    try {
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
      // Re-read the schema version after acquiring the write lock. Two workers
      // may initialize the same empty database at the same time.
      db.exec("BEGIN IMMEDIATE;");
      try {
        const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
        if (version > 1) throw new Error("Approval database schema is newer than this Sofia Agent supports.");
        if (version === 0) {
          db.exec(`
            CREATE TABLE approvals (
              id TEXT PRIMARY KEY NOT NULL,
              run_id TEXT NOT NULL,
              principal_id TEXT NOT NULL,
              tool_name TEXT NOT NULL,
              action_hash TEXT NOT NULL,
              risk TEXT NOT NULL,
              status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired','cancelled','interrupted')),
              created_at INTEGER NOT NULL,
              expires_at INTEGER NOT NULL,
              settled_at INTEGER
            );
            CREATE INDEX approvals_owner_created_idx ON approvals(principal_id, created_at DESC, id);
            CREATE INDEX approvals_owner_pending_idx ON approvals(principal_id, status, expires_at);
            PRAGMA user_version = 1;
          `);
        }
        db.exec("COMMIT;");
      } catch (error) {
        db.exec("ROLLBACK;");
        throw error;
      }
      const store = new SqliteApprovalStore(db, absolutePath);
      store.restrictPermissions();
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private restrictPermissions(): void {
    if (this.filePath === ":memory:" || process.platform === "win32") return;
    for (const file of [this.filePath, this.filePath + "-wal", this.filePath + "-shm"]) {
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Approval database sidecars must be regular files.");
        fs.chmodSync(file, stat.mode & 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  createPending(record: ApprovalAuditRecord): boolean {
    if (record.status !== "pending" || !record.id || !record.principalId || !record.runId ||
        !record.actionHash || !record.toolName || !Number.isSafeInteger(record.expiresAt) ||
        !Number.isSafeInteger(record.createdAt)) return false;
    try {
      const result = this.db.prepare(`
        INSERT INTO approvals(id, run_id, principal_id, tool_name, action_hash, risk, status, created_at, expires_at, settled_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL)
      `).run(record.id, record.runId, record.principalId, record.toolName, record.actionHash,
        record.risk, record.createdAt, record.expiresAt);
      this.restrictPermissions();
      return Number(result.changes) === 1;
    } catch {
      // Duplicate IDs and storage failures fail closed.
      return false;
    }
  }

  settlePending(
    id: string,
    principalId: string,
    actionHash: string,
    status: Exclude<ApprovalAuditStatus, "pending">,
    settledAt: number,
  ): boolean {
    if (!id || !principalId || !actionHash || !Number.isSafeInteger(settledAt) || settledAt < 0) return false;
    // Enforce terminal states at runtime too: JavaScript callers and untrusted
    // adapters can bypass the TypeScript Exclude<> constraint. In particular,
    // allowing "pending" here would permit a supposedly one-time transition
    // to leave the record actionable.
    if (status !== "approved" && status !== "rejected" &&
        status !== "cancelled" && status !== "interrupted") return false;
    try {
      const result = this.db.prepare(`
        UPDATE approvals SET status = ?, settled_at = ?
        WHERE id = ? AND principal_id = ? AND action_hash = ?
          AND status = 'pending' AND expires_at > ?
      `).run(status, settledAt, id, principalId, actionHash, settledAt);
      this.restrictPermissions();
      return Number(result.changes) === 1;
    } catch {
      return false;
    }
  }

  expirePending(now: number): number {
    if (!Number.isSafeInteger(now)) return 0;
    const result = this.db.prepare(`
      UPDATE approvals SET status = 'expired', settled_at = ?
      WHERE status = 'pending' AND expires_at <= ?
    `).run(now, now);
    this.restrictPermissions();
    return Number(result.changes);
  }

  pending(principalId: string, now = Date.now()): ApprovalAuditRecord[] {
    const owner = principalId.trim();
    if (!owner) return [];
    this.expirePending(now);
    const rows = this.db.prepare(`
      SELECT id, run_id, principal_id, tool_name, action_hash, risk, status, created_at, expires_at, settled_at
      FROM approvals WHERE principal_id = ? AND status = 'pending'
      ORDER BY created_at ASC, id ASC
    `).all(owner) as ApprovalRow[];
    return rows.map(toRecord);
  }

  history(principalId: string, limit = 100): ApprovalAuditRecord[] {
    const owner = principalId.trim();
    if (!owner) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) {
      throw new RangeError("Approval history limit must be between 1 and 5000.");
    }
    const rows = this.db.prepare(`
      SELECT id, run_id, principal_id, tool_name, action_hash, risk, status, created_at, expires_at, settled_at
      FROM approvals WHERE principal_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(owner, limit) as ApprovalRow[];
    return rows.map(toRecord);
  }

  close(): void { this.db.close(); }
}

interface ApprovalRow {
  id: string;
  run_id: string;
  principal_id: string;
  tool_name: string;
  action_hash: string;
  risk: RiskLevel;
  status: ApprovalAuditStatus;
  created_at: number;
  expires_at: number;
  settled_at: number | null;
}

function toRecord(row: ApprovalRow): ApprovalAuditRecord {
  return {
    id: row.id,
    runId: row.run_id,
    principalId: row.principal_id,
    toolName: row.tool_name,
    actionHash: row.action_hash,
    risk: row.risk,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
  };
}
