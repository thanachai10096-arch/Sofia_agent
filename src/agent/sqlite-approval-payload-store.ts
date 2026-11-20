import fs from "node:fs";
import path from "node:path";
import type { ApprovalPayloadCipher, ApprovalPayloadContext, EncryptedApprovalPayload } from "./approval-payload-cipher.js";

type SqliteDatabase = import("node:sqlite").DatabaseSync;

const MAX_ENVELOPE_BYTES = 256 * 1024;

function validContext(context: ApprovalPayloadContext): boolean {
  return Boolean(context && context.approvalId && context.principalId && context.runId &&
    context.toolName && context.actionHash && Number.isSafeInteger(context.expiresAt) &&
    context.expiresAt >= 0);
}

function validEnvelope(value: unknown): value is EncryptedApprovalPayload {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Record<string, unknown>;
  return envelope.version === 1 && envelope.algorithm === "aes-256-gcm" &&
    typeof envelope.keyId === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(envelope.keyId) &&
    typeof envelope.nonce === "string" && typeof envelope.tag === "string" &&
    typeof envelope.ciphertext === "string";
}

/**
 * Stores only an AES-GCM envelope for a matching pending approval.
 * The caller must encrypt with Aes256GcmApprovalPayloadCipher before saving
 * and decrypt only after loading with the original server-derived context.
 * This is a same-host SQLite primitive, not a multi-host coordination layer.
 */
export class SqliteApprovalPayloadStore {
  private constructor(private readonly db: SqliteDatabase) {}

  static async open(filePath: string): Promise<SqliteApprovalPayloadStore> {
    if (!filePath.trim() || filePath === ":memory:") {
      throw new Error("Approval payload store requires a persistent SQLite file path.");
    }
    const absolutePath = path.resolve(filePath);
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Approval database path must be a regular file, not a symbolic link.");
    }
    if (process.platform !== "win32") fs.chmodSync(absolutePath, stat.mode & 0o600);

    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 5)) {
      throw new Error("SqliteApprovalPayloadStore requires Node.js 22.5 or newer (node:sqlite).");
    }
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(absolutePath);
    try {
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
      db.exec("BEGIN IMMEDIATE;");
      try {
        const approvalTable = db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approvals'",
        ).get();
        if (!approvalTable) throw new Error("Initialize SqliteApprovalStore before the payload store.");
        db.exec(`
          CREATE TABLE IF NOT EXISTS approval_payloads (
            approval_id TEXT PRIMARY KEY NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
            envelope_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
        `);
        db.exec("COMMIT;");
      } catch (error) {
        db.exec("ROLLBACK;");
        throw error;
      }
      return new SqliteApprovalPayloadStore(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  save(plaintext: string, context: ApprovalPayloadContext, cipher: ApprovalPayloadCipher, now = Date.now()): boolean {
    if (typeof plaintext !== "string" || !validContext(context) || !Number.isSafeInteger(now)) return false;
    try {
      const envelope = cipher.encrypt(plaintext, context);
      if (!validEnvelope(envelope)) return false;
      const serialized = JSON.stringify(envelope);
      if (Buffer.byteLength(serialized, "utf8") > MAX_ENVELOPE_BYTES) return false;
      const result = this.db.prepare(`
        INSERT INTO approval_payloads(approval_id, envelope_json, created_at)
        SELECT ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM approvals
          WHERE id = ? AND principal_id = ? AND run_id = ? AND tool_name = ?
            AND action_hash = ? AND expires_at = ? AND status = 'pending' AND expires_at > ?
        )
        ON CONFLICT(approval_id) DO NOTHING
      `).run(context.approvalId, serialized, now, context.approvalId, context.principalId,
        context.runId, context.toolName, context.actionHash, context.expiresAt, now);
      return Number(result.changes) === 1;
    } catch {
      return false;
    }
  }

  load(context: ApprovalPayloadContext, cipher: ApprovalPayloadCipher, now = Date.now()): string | null {
    if (!validContext(context) || !Number.isSafeInteger(now)) return null;
    try {
      const row = this.db.prepare(`
        SELECT p.envelope_json
        FROM approval_payloads p
        JOIN approvals a ON a.id = p.approval_id
        WHERE a.id = ? AND a.principal_id = ? AND a.run_id = ? AND a.tool_name = ?
          AND a.action_hash = ? AND a.expires_at = ? AND a.status = 'pending' AND a.expires_at > ?
      `).get(context.approvalId, context.principalId, context.runId, context.toolName,
        context.actionHash, context.expiresAt, now) as { envelope_json: string } | undefined;
      if (!row || Buffer.byteLength(row.envelope_json, "utf8") > MAX_ENVELOPE_BYTES) return null;
      const parsed: unknown = JSON.parse(row.envelope_json);
      return validEnvelope(parsed) ? cipher.decrypt(parsed, context) : null;
    } catch {
      return null;
    }
  }

  delete(approvalId: string): boolean {
    if (!approvalId) return false;
    try {
      const result = this.db.prepare("DELETE FROM approval_payloads WHERE approval_id = ?").run(approvalId);
      return Number(result.changes) === 1;
    } catch {
      return false;
    }
  }

  close(): void {
    this.db.close();
  }
}
