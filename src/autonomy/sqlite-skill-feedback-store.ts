import fs from "node:fs";
import path from "node:path";
import type { TenantResourceContext, TenantResourceResolver } from "../platform/tenant-resolver.js";
import type { SkillFeedbackState, SkillFeedbackStore } from "./skill-feedback.js";
type SqliteDatabase = import("node:sqlite").DatabaseSync;
function restrictFile(filePath: string): void {
  if (process.platform === "win32") return;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Skill feedback database must be a regular file.");
  const privateMode = stat.mode & 0o600;
  if (privateMode !== (stat.mode & 0o777)) fs.chmodSync(filePath, privateMode);
}
/** Durable SQLite adapter; BEGIN IMMEDIATE makes idempotent read-modify-write atomic. */
export class SqliteSkillFeedbackStore implements SkillFeedbackStore {
  private constructor(private readonly db: SqliteDatabase, private readonly filePath: string) {}
  static async open(filePath: string): Promise<SqliteSkillFeedbackStore> {
    if (!path.isAbsolute(filePath)) throw new Error("Skill feedback database path must be absolute.");
    const absolute = path.resolve(filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
    try { const fd = fs.openSync(absolute, "wx", 0o600); fs.closeSync(fd); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    restrictFile(absolute);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(absolute);
    try {
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
      const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
      if (version > 1) throw new Error("Skill feedback schema is newer than this Sofia Agent supports.");
      if (version === 0) db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE skill_feedback_scopes (
          scope TEXT PRIMARY KEY NOT NULL,
          state_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        PRAGMA user_version = 1;
        COMMIT;
      `);
      restrictFile(absolute);
      return new SqliteSkillFeedbackStore(db, absolute);
    } catch (error) { db.close(); throw error; }
  }
  async transact<T>(scope: string, operation: (state: SkillFeedbackState) => T | Promise<T>): Promise<T> {
    if (!scope?.trim() || scope.length > 512) throw new Error("Skill feedback scope is invalid.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT state_json FROM skill_feedback_scopes WHERE scope = ?").get(scope) as { state_json: string } | undefined;
      let state: SkillFeedbackState = { entries: [], idempotency: {} };
      if (row) {
        const parsed: unknown = JSON.parse(row.state_json);
        if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as SkillFeedbackState).entries) ||
            !(parsed as SkillFeedbackState).idempotency || typeof (parsed as SkillFeedbackState).idempotency !== "object") {
          throw new Error("Skill feedback database contains malformed state.");
        }
        state = parsed as SkillFeedbackState;
      }
      const result = await operation(state);
      this.db.prepare(`INSERT INTO skill_feedback_scopes(scope, state_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`)
        .run(scope, JSON.stringify(state), Date.now());
      this.db.exec("COMMIT");
      restrictFile(this.filePath);
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.db.close(); }
}
/** Opens durable feedback storage only from a resolver-issued tenant context. */
export async function openTenantSkillFeedbackStore(resolver: TenantResourceResolver, context: TenantResourceContext): Promise<SqliteSkillFeedbackStore> {
  resolver.assertContext(context);
  return SqliteSkillFeedbackStore.open(path.join(context.workspaceRoot, ".sofia", "skill-feedback.sqlite"));
}
