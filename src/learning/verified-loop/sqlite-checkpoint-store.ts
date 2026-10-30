import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { LearningScope } from "./ports.js";
import type { SelfImprovementCheckpointStore, VerifiedExecutionNotification } from "./self-improvement.js";

type SqliteDatabase = DatabaseSyncType;
type CheckpointState = { lastSequence: number; pending: VerifiedExecutionNotification[] };

function validScope(scope: LearningScope): boolean {
  return Boolean(scope && typeof scope.tenantId === "string" && scope.tenantId.trim() &&
    typeof scope.principalId === "string" && scope.principalId.trim() &&
    typeof scope.projectId === "string" && scope.projectId.trim());
}
function validateState(state: CheckpointState): void {
  if (!state || !Number.isSafeInteger(state.lastSequence) || state.lastSequence < 0 || !Array.isArray(state.pending)) {
    throw new Error("Invalid self-improvement checkpoint state");
  }
  const seen = new Set<number>();
  for (const item of state.pending) {
    if (!item || !Number.isSafeInteger(item.sequence) || item.sequence <= state.lastSequence ||
      item.sequence < 1 || typeof item.receiptId !== "string" || !item.receiptId.trim() ||
      typeof item.summary !== "string" || seen.has(item.sequence)) {
      throw new Error("Invalid pending self-improvement notification");
    }
    seen.add(item.sequence);
  }
}
function secureRegularFile(filePath: string): void {
  if (process.platform === "win32" || filePath === ":memory:") return;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Learning checkpoint path must be a regular file, not a symbolic link");
    const mode = stat.mode & 0o777;
    const privateMode = mode & 0o600;
    if (privateMode !== mode) fs.chmodSync(filePath, privateMode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

/**
 * Durable, cross-process SQLite checkpoint implementation for the verified-learning
 * delivery cursor. Writes use BEGIN IMMEDIATE and one atomic upsert per scope.
 * This stores delivery metadata only; it is not a verification-evidence store.
 */
export class SqliteSelfImprovementCheckpointStore implements SelfImprovementCheckpointStore {
  private constructor(private readonly db: SqliteDatabase, private readonly filePath: string) {}

  static async open(filePath: string): Promise<SqliteSelfImprovementCheckpointStore> {
    if (typeof filePath !== "string" || !filePath.trim()) throw new Error("Checkpoint database path is required");
    const absolutePath = filePath === ":memory:" ? filePath : path.resolve(filePath);
    if (absolutePath !== ":memory:") {
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
      try {
        const fd = fs.openSync(absolutePath, "wx", 0o600);
        fs.closeSync(fd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      secureRegularFile(absolutePath);
    }
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(absolutePath);
    try {
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
      secureRegularFile(absolutePath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS verified_learning_checkpoints (
          tenant_id TEXT NOT NULL,
          principal_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
          pending_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (tenant_id, principal_id, project_id)
        );
      `);
      secureRegularFile(absolutePath);
      return new SqliteSelfImprovementCheckpointStore(db, absolutePath);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  async read(scope: LearningScope): Promise<CheckpointState> {
    this.assertScope(scope);
    const row = this.db.prepare(`
      SELECT last_sequence, pending_json FROM verified_learning_checkpoints
      WHERE tenant_id = ? AND principal_id = ? AND project_id = ?
    `).get(scope.tenantId, scope.principalId, scope.projectId) as
      | { last_sequence: number; pending_json: string }
      | undefined;
    if (!row) return { lastSequence: 0, pending: [] };
    let pending: unknown;
    try { pending = JSON.parse(row.pending_json); }
    catch { throw new Error("Corrupt self-improvement checkpoint JSON"); }
    const state = { lastSequence: row.last_sequence, pending } as CheckpointState;
    validateState(state);
    return { lastSequence: state.lastSequence, pending: state.pending.map(item => ({ ...item })) };
  }

  async write(scope: LearningScope, state: CheckpointState): Promise<void> {
    this.assertScope(scope);
    validateState(state);
    const pending = [...state.pending].sort((a, b) => a.sequence - b.sequence);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO verified_learning_checkpoints
          (tenant_id, principal_id, project_id, last_sequence, pending_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, principal_id, project_id) DO UPDATE SET
          last_sequence = excluded.last_sequence,
          pending_json = excluded.pending_json,
          updated_at = excluded.updated_at
      `).run(scope.tenantId, scope.principalId, scope.projectId, state.lastSequence, JSON.stringify(pending), Date.now());
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
    secureRegularFile(this.filePath);
  }

  close(): void { this.db.close(); }

  private assertScope(scope: LearningScope): void {
    if (!validScope(scope)) throw new Error("Invalid authenticated learning scope");
  }
}
