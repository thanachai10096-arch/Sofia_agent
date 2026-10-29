import fs from "node:fs";
import path from "node:path";
import { sofiaStateDirectory } from "../platform/state-directory.js";
import type { Session } from "./store.js";

function restrictFilePermissions(filePath: string): void {
  // Windows uses ACLs rather than POSIX mode bits; preserve its inherited ACLs.
  if (process.platform === "win32") return;
  try {
    // lstat avoids following a pre-existing symlink before changing permissions.
    const fileStat = fs.lstatSync(filePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error("Session storage paths must be regular files, not symbolic links.");
    }
    const currentMode = fileStat.mode & 0o777;
    // Remove group/other access without granting any owner permissions that were absent.
    const privateMode = currentMode & 0o600;
    if (privateMode !== currentMode) fs.chmodSync(filePath, privateMode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function restrictSqlitePermissions(filePath: string): void {
  if (filePath === ":memory:" || process.platform === "win32") return;
  restrictFilePermissions(filePath);
  // SQLite creates these sidecars lazily; re-apply privacy after transactions too.
  restrictFilePermissions(`${filePath}-wal`);
  restrictFilePermissions(`${filePath}-shm`);
}

type SqliteDatabase = import("node:sqlite").DatabaseSync;

/**
 * Durable SQLite-backed session storage.
 *
 * Node's built-in SQLite module is loaded only when this store is opened, so
 * importing Sofia Agent on older supported Node versions does not break.
 * Opening this store requires a Node release that provides node:sqlite.
 */
export class SqliteSessionStore {
  private constructor(private readonly db: SqliteDatabase, private readonly filePath: string) {}

  static async open(filePath = path.join(sofiaStateDirectory("sessions"), "sessions.sqlite")): Promise<SqliteSessionStore> {
    const absolutePath = filePath === ":memory:" ? filePath : path.resolve(filePath);
    if (absolutePath !== ":memory:") {
      // Newly-created directories are private; existing directory modes are left untouched.
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
      try {
        const fd = fs.openSync(absolutePath, "wx", 0o600);
        fs.closeSync(fd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      // Existing database files are tightened only; no owner permissions are added.
      restrictFilePermissions(absolutePath);
    }
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(absolutePath);
    try {
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
      restrictSqlitePermissions(absolutePath);
      const store = new SqliteSessionStore(db, absolutePath);
      store.migrate();
      restrictSqlitePermissions(absolutePath);
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private migrate(): void {
    const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > 1) throw new Error(`Session database schema version ${version} is newer than this Sofia Agent supports.`);
    if (version === 0) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE session_messages (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          position INTEGER NOT NULL CHECK (position >= 0),
          content TEXT NOT NULL,
          PRIMARY KEY (session_id, position)
        );
        CREATE INDEX sessions_updated_at_idx ON sessions(updated_at DESC, id);
        PRAGMA user_version = 1;
        COMMIT;
      `);
    }
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts
        USING fts5(session_id UNINDEXED, content, tokenize='unicode61');
      `);
      this.ftsAvailable = true;
      this.rebuildFts();
    } catch {
      // FTS5 is optional; search() falls back to parameterized LIKE queries.
      this.ftsAvailable = false;
    }
  }

  private ftsAvailable = false;

  private rebuildFts(): void {
    if (!this.ftsAvailable) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM session_messages_fts");
      this.db.exec(`
        INSERT INTO session_messages_fts(session_id, content)
        SELECT session_id, content FROM session_messages
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(id: string): Session | undefined {
    const row = this.db.prepare("SELECT id, updated_at FROM sessions WHERE id = ?").get(id) as
      | { id: string; updated_at: number }
      | undefined;
    if (!row) return undefined;
    const messages = this.db.prepare(
      "SELECT content FROM session_messages WHERE session_id = ? ORDER BY position ASC",
    ).all(id) as Array<{ content: string }>;
    return { id: row.id, updatedAt: row.updated_at, messages: messages.map((message) => message.content) };
  }

  getOrCreate(id: string): Session {
    const existing = this.get(id);
    if (existing) return existing;
    const created: Session = { id, messages: [], updatedAt: Date.now() };
    this.save(created);
    return created;
  }

  save(session: Session): void {
    if (!session.id) throw new Error("Session id must not be empty.");
    if (!Array.isArray(session.messages) || session.messages.some((message) => typeof message !== "string")) {
      throw new TypeError("Session messages must be an array of strings.");
    }
    const updatedAt = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        "INSERT INTO sessions(id, updated_at) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at",
      ).run(session.id, updatedAt);
      this.db.prepare("DELETE FROM session_messages WHERE session_id = ?").run(session.id);
      if (this.ftsAvailable) {
        this.db.prepare("DELETE FROM session_messages_fts WHERE session_id = ?").run(session.id);
      }
      const insertMessage = this.db.prepare(
        "INSERT INTO session_messages(session_id, position, content) VALUES (?, ?, ?)",
      );
      const insertFts = this.ftsAvailable
        ? this.db.prepare("INSERT INTO session_messages_fts(session_id, content) VALUES (?, ?)")
        : undefined;
      session.messages.forEach((message, position) => {
        insertMessage.run(session.id, position, message);
        insertFts?.run(session.id, message);
      });
      this.db.exec("COMMIT");
      session.updatedAt = updatedAt;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    restrictSqlitePermissions(this.filePath);
  }

  listMessages(id: string, options: { limit?: number; offset?: number } = {}): string[] {
    const limit = boundedInteger(options.limit, 50, 1, 500);
    const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const rows = this.db.prepare(
      "SELECT content FROM session_messages WHERE session_id = ? ORDER BY position ASC LIMIT ? OFFSET ?",
    ).all(id, limit, offset) as Array<{ content: string }>;
    return rows.map((row) => row.content);
  }

  listSessions(options: { limit?: number; offset?: number } = {}): Session[] {
    const limit = boundedInteger(options.limit, 50, 1, 500);
    const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const rows = this.db.prepare(
      "SELECT id, updated_at FROM sessions ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?",
    ).all(limit, offset) as Array<{ id: string; updated_at: number }>;
    return rows.map((row) => this.get(row.id)).filter((session): session is Session => session !== undefined);
  }

  search(query: string, options: { limit?: number; offset?: number } = {}): Session[] {
    if (typeof query !== "string") throw new TypeError("Session search query must be a string.");
    const term = query.trim();
    if (!term) return [];
    // Bound work on both FTS and LIKE fallback paths for untrusted callers.
    if (term.length > 1000) throw new RangeError("Session search query must not exceed 1000 characters.");
    const limit = boundedInteger(options.limit, 20, 1, 100);
    const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    let ids: string[];
    if (this.ftsAvailable) {
      const ftsQuery = term.split(/\s+/u).filter(Boolean).map((part) => `"${part.replace(/"/gu, '""')}"`).join(" AND ");
      try {
        ids = (this.db.prepare(`
          SELECT DISTINCT session_id AS id
          FROM session_messages_fts
          WHERE session_messages_fts MATCH ?
          LIMIT ? OFFSET ?
        `).all(ftsQuery, limit, offset) as Array<{ id: string }>).map((row) => row.id);
      } catch {
        ids = this.searchLike(term, limit, offset);
      }
    } else {
      ids = this.searchLike(term, limit, offset);
    }
    return ids.map((id) => this.get(id)).filter((session): session is Session => session !== undefined);
  }

  private searchLike(term: string, limit: number, offset: number): string[] {
    const pattern = `%${term.replace(/[\\%_]/gu, "\\$&")}%`;
    return (this.db.prepare(`
      SELECT DISTINCT s.id
      FROM sessions s JOIN session_messages m ON m.session_id = s.id
      WHERE m.content LIKE ? ESCAPE '\\'
      ORDER BY s.updated_at DESC, s.id ASC
      LIMIT ? OFFSET ?
    `).all(pattern, limit, offset) as Array<{ id: string }>).map((row) => row.id);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    if (this.ftsAvailable) this.db.prepare("DELETE FROM session_messages_fts WHERE session_id = ?").run(id);
  }

  close(): void { this.db.close(); }
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`Expected an integer between ${min} and ${max}.`);
  }
  return value;
}
