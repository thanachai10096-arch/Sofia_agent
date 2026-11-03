import fs from "node:fs";
import path from "node:path";
import { sofiaStateDirectory } from "../platform/state-directory.js";
import type { ChatDelegationPlatform, ChatDelegationReplayStore } from "./chat-delegation.js";

type SqliteDatabase = import("node:sqlite").DatabaseSync;

const PLATFORM_VALUES = new Set<ChatDelegationPlatform>(["telegram", "discord", "slack"]);

function ensurePrivateRegularFile(filePath: string): void {
  if (process.platform === "win32") return;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Chat delegation replay storage must be a regular file, not a symbolic link.");
    }
    const mode = stat.mode & 0o777;
    const privateMode = mode & 0o600;
    if (privateMode !== mode) fs.chmodSync(filePath, privateMode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

/**
 * Durable, single-database replay protection for chat delegation.
 *
 * Each claim is committed under BEGIN IMMEDIATE and protected by a composite
 * primary key, so concurrent API processes sharing this SQLite file cannot
 * both claim the same (tenant, platform, nonce). For multi-host deployments,
 * use a shared transactional database rather than per-host local disk.
 */
export class SqliteChatDelegationReplayStore implements ChatDelegationReplayStore {
  private constructor(private readonly db: SqliteDatabase, private readonly filePath: string) {}

  static async open(
    filePath = path.join(sofiaStateDirectory("security"), "chat-delegation-replay.sqlite"),
  ): Promise<SqliteChatDelegationReplayStore> {
    const absolutePath = filePath === ":memory:" ? filePath : path.resolve(filePath);
    if (absolutePath !== ":memory:") {
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
      try {
        const fd = fs.openSync(absolutePath, "wx", 0o600);
        fs.closeSync(fd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      ensurePrivateRegularFile(absolutePath);
    }

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(absolutePath);
    try {
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
      ensurePrivateRegularFile(absolutePath);
      const store = new SqliteChatDelegationReplayStore(db, absolutePath);
      store.migrate();
      ensurePrivateRegularFile(absolutePath);
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private migrate(): void {
    const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > 1) {
      throw new Error(`Chat delegation replay database schema version ${version} is newer than this Sofia Agent supports.`);
    }
    if (version === 0) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE chat_delegation_nonces (
          tenant_id TEXT NOT NULL,
          platform TEXT NOT NULL CHECK (platform IN ('telegram', 'discord', 'slack')),
          nonce TEXT NOT NULL,
          expires_at INTEGER NOT NULL CHECK (expires_at > 0),
          PRIMARY KEY (tenant_id, platform, nonce)
        ) WITHOUT ROWID;
        CREATE INDEX chat_delegation_nonces_expiry_idx ON chat_delegation_nonces(expires_at);
        PRAGMA user_version = 1;
        COMMIT;
      `);
    }
  }

  async claim(input: {
    tenantId: string;
    platform: ChatDelegationPlatform;
    nonce: string;
    expiresAt: number;
  }): Promise<boolean> {
    if (!input || typeof input.tenantId !== "string" || input.tenantId.length < 1 ||
        input.tenantId.length > 128 || !/^[A-Za-z0-9:_-]+$/.test(input.tenantId) ||
        !PLATFORM_VALUES.has(input.platform) || typeof input.nonce !== "string" ||
        !/^[A-Za-z0-9_-]{22,128}$/.test(input.nonce) ||
        !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0) {
      throw new TypeError("Invalid chat delegation replay claim.");
    }

    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Remove expired claims inside the same write transaction as the insert.
      this.db.prepare("DELETE FROM chat_delegation_nonces WHERE expires_at <= ?").run(now);
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO chat_delegation_nonces(tenant_id, platform, nonce, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(input.tenantId, input.platform, input.nonce, input.expiresAt);
      this.db.exec("COMMIT");
      ensurePrivateRegularFile(this.filePath);
      return Number(result.changes) === 1;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
