import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BackupBundle, BackupRestoreTargetAdapter } from "./backup-coordinator.js";

export interface SqliteRestoreLifecycle {
  /** Returns the currently open session store; its snapshot method must be consistent. */
  getOpenStore(): { createConsistentSnapshot(destinationPath: string): string };
  /** Close every connection to this database before replacement. */
  close(): Promise<void>;
  /** Re-open the database and refresh the caller's store reference after replacement. */
  reopen(): Promise<void>;
}

type SqliteRollbackSnapshot = { bytes: Uint8Array };

/**
 * Database-aware restore adapter for one SQLite database file.
 *
 * Callers must provide lifecycle hooks that close all connections and refresh
 * their store reference on reopen. The adapter snapshots via SQLite VACUUM INTO
 * before mutation, then replaces the database only while it is closed and
 * removes stale WAL/SHM sidecars. It does not manage application-level writers;
 * the caller must quiesce them for the duration of the restore transaction.
 */
export function sqliteFileBackupRestoreAdapter(
  name: string,
  databasePath: string,
  backupPath: string,
  lifecycle: SqliteRestoreLifecycle,
): BackupRestoreTargetAdapter {
  const database = path.resolve(databasePath);
  const relativePath = backupPath;
  let databaseClosed = false;

  async function closeDatabase(): Promise<void> {
    if (databaseClosed) return;
    await lifecycle.close();
    databaseClosed = true;
  }

  async function reopenDatabase(): Promise<void> {
    if (!databaseClosed) return;
    await lifecycle.reopen();
    databaseClosed = false;
  }
  if (!name.trim()) throw new Error("SQLite restore adapter name is required.");
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\\") ||
      relativePath.split("/").some((part) => !part || part === "." || part === ".." || part.includes(":"))) {
    throw new Error("SQLite restore adapter requires a safe relative backup path.");
  }

  async function ensureDatabasePath(): Promise<void> {
    const parent = path.dirname(database);
    const parentInfo = await fs.lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
      throw new Error("SQLite restore database parent must be a real directory.");
    }
    const info = await fs.lstat(database).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!info || info.isSymbolicLink() || !info.isFile()) {
      throw new Error("SQLite restore destination must be an existing regular file, not a symbolic link.");
    }
  }

  async function readConsistentSnapshot(): Promise<Uint8Array> {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sofia-sqlite-rollback-"));
    try {
      if (process.platform !== "win32") await fs.chmod(temporaryDirectory, 0o700);
      const snapshotPath = path.join(temporaryDirectory, "snapshot.sqlite");
      lifecycle.getOpenStore().createConsistentSnapshot(snapshotPath);
      const bytes = await fs.readFile(snapshotPath);
      await verifySqliteIntegrity(bytes);
      return bytes;
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }


  async function verifySqliteIntegrity(bytes: Uint8Array): Promise<void> {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sofia-sqlite-preflight-"));
    try {
      if (process.platform !== "win32") await fs.chmod(temporaryDirectory, 0o700);
      const candidatePath = path.join(temporaryDirectory, "candidate.sqlite");
      await fs.writeFile(candidatePath, bytes, { flag: "wx", mode: 0o600 });
      const { DatabaseSync } = await import("node:sqlite");
      const database = new DatabaseSync(candidatePath, { readOnly: true });
      try {
        database.exec("PRAGMA trusted_schema = OFF");
        const rows = database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
        if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
          throw new Error("SQLite restore backup failed PRAGMA integrity_check.");
        }
      } finally {
        database.close();
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown SQLite validation error";
      throw new Error(`SQLite restore backup failed integrity validation: ${detail}`, { cause: error });
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async function replaceDatabase(bytes: Uint8Array): Promise<void> {
    const temporary = path.join(path.dirname(database), ".sofia-sqlite-restore-" + randomUUID() + ".tmp");
    try {
      await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      if (process.platform !== "win32") await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, database);
      // Only remove sidecars after all database connections have been closed.
      await fs.rm(database + "-wal", { force: true });
      await fs.rm(database + "-shm", { force: true });
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  return {
    name,
    paths: [relativePath],
    async preflight(bundle, selectedPaths) {
      if (selectedPaths.length !== 1 || selectedPaths[0] !== relativePath ||
          !bundle.manifest.entries.some((entry) => entry.path === relativePath) ||
          !bundle.files.has(relativePath)) {
        throw new Error("SQLite restore selection must contain its configured verified database file.");
      }
      await ensureDatabasePath();
      const bytes = bundle.files.get(relativePath)!;
      if (bytes.byteLength === 0) throw new Error("SQLite restore backup file must not be empty.");
      // SQLite header validation catches wrong-file inputs before live state changes.
      const header = Buffer.from(bytes.subarray(0, 16)).toString("ascii");
      if (header !== "SQLite format 3\0") {
        throw new Error("SQLite restore backup does not have a valid SQLite database header.");
      }
      await verifySqliteIntegrity(bytes);
    },
    async captureRollback(): Promise<SqliteRollbackSnapshot> {
      await ensureDatabasePath();
      return { bytes: await readConsistentSnapshot() };
    },
    async apply(bundle: BackupBundle, selectedPaths) {
      if (selectedPaths.length !== 1 || selectedPaths[0] !== relativePath) {
        throw new Error("SQLite restore apply received an unexpected path selection.");
      }
      const bytes = bundle.files.get(relativePath);
      if (!bytes || Buffer.from(bytes.subarray(0, 16)).toString("ascii") !== "SQLite format 3\0") {
        throw new Error("SQLite restore bundle is missing a valid database snapshot.");
      }
      // Re-validate immediately before closing the live database in case bundle bytes changed after preflight.
      await verifySqliteIntegrity(bytes);
      await closeDatabase();
      await replaceDatabase(bytes);
      await reopenDatabase();
    },
    async rollback(rawSnapshot) {
      if (!rawSnapshot || typeof rawSnapshot !== "object" ||
          !("bytes" in rawSnapshot) || !(rawSnapshot.bytes instanceof Uint8Array)) {
        throw new Error("SQLite restore rollback snapshot is invalid.");
      }
      // Validate rollback material before closing or replacing the current database.
      await verifySqliteIntegrity(rawSnapshot.bytes);
      await closeDatabase();
      await replaceDatabase(rawSnapshot.bytes);
      await reopenDatabase();
    },
    serializeRollbackSnapshot(rawSnapshot) {
      if (!rawSnapshot || typeof rawSnapshot !== "object" ||
          !("bytes" in rawSnapshot) || !(rawSnapshot.bytes instanceof Uint8Array)) {
        throw new Error("SQLite restore rollback snapshot is invalid.");
      }
      return new Uint8Array(rawSnapshot.bytes);
    },
    async rollbackFromSnapshotBytes(bytes) {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
        throw new Error("Persisted SQLite rollback snapshot is invalid.");
      }
      await ensureDatabasePath();
      await verifySqliteIntegrity(bytes);
      await closeDatabase();
      await replaceDatabase(bytes);
      await reopenDatabase();
    },
  };
}
