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
    try {
      const info = await fs.lstat(database);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error("SQLite restore destination must be a regular file, not a symbolic link.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async function readConsistentSnapshot(): Promise<Uint8Array> {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sofia-sqlite-rollback-"));
    try {
      if (process.platform !== "win32") await fs.chmod(temporaryDirectory, 0o700);
      const snapshotPath = path.join(temporaryDirectory, "snapshot.sqlite");
      lifecycle.getOpenStore().createConsistentSnapshot(snapshotPath);
      return await fs.readFile(snapshotPath);
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
      if (header !== "SQLite format 3\\u0000") {
        throw new Error("SQLite restore backup does not have a valid SQLite database header.");
      }
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
      if (!bytes || Buffer.from(bytes.subarray(0, 16)).toString("ascii") !== "SQLite format 3\\u0000") {
        throw new Error("SQLite restore bundle is missing a valid database snapshot.");
      }
      await lifecycle.close();
      await replaceDatabase(bytes);
      await lifecycle.reopen();
    },
    async rollback(rawSnapshot) {
      if (!rawSnapshot || typeof rawSnapshot !== "object" ||
          !("bytes" in rawSnapshot) || !(rawSnapshot.bytes instanceof Uint8Array)) {
        throw new Error("SQLite restore rollback snapshot is invalid.");
      }
      await lifecycle.close();
      await replaceDatabase(rawSnapshot.bytes);
      await lifecycle.reopen();
    },
  };
}
