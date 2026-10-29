import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SqliteSessionStore } from "../session/sqlite-store.js";
import type { FileProjectMemoryStore } from "../brain/project-memory.js";
import type { FileUserMemoryStore } from "../brain/user-memory.js";
import {
  createBackupManifest,
  MAX_BACKUP_MANIFEST_ENTRIES,
  verifyBackupFiles,
  type BackupInputFile,
  type BackupManifest,
  type BackupVerificationResult,
} from "./backup-manifest.js";

export interface BackupSnapshotSource {
  /** Stable, non-secret identifier for diagnostics. */
  name: string;
  /** Must return a consistent, read-only snapshot; must not mutate live state. */
  snapshot(): Promise<readonly BackupInputFile[]>;
}

export interface BackupBundle {
  manifest: BackupManifest;
  /** Snapshot bytes keyed by the manifest's relative POSIX paths. */
  files: ReadonlyMap<string, Uint8Array>;
}

export type BackupBundleVerification = BackupVerificationResult;

/**
 * Collect in-memory snapshots from explicitly supplied stores and verify the
 * complete result before returning it. This is not an archive writer and does
 * not imply that the caller supplied every persistent Sofia store.
 */
export async function createBackupBundle(
  sources: readonly BackupSnapshotSource[],
  createdAt?: string,
): Promise<BackupBundle> {
  const names = new Set<string>();
  const files: BackupInputFile[] = [];

  for (const source of sources) {
    if (!source || typeof source.name !== "string" || source.name.trim().length === 0) {
      throw new Error("Backup snapshot source must have a non-empty name.");
    }
    if (names.has(source.name)) throw new Error(`Duplicate backup snapshot source: ${source.name}`);
    names.add(source.name);
    if (typeof source.snapshot !== "function") {
      throw new Error(`Backup snapshot source ${source.name} has no snapshot function.`);
    }

    // Run sequentially to avoid a burst of disk/memory pressure and keep source
    // behavior deterministic. Each source owns its consistency boundary.
    const snapshotFiles = await source.snapshot();
    if (!Array.isArray(snapshotFiles)) {
      throw new Error(`Backup snapshot source ${source.name} returned an invalid snapshot.`);
    }
    if (files.length + snapshotFiles.length > MAX_BACKUP_MANIFEST_ENTRIES) {
      throw new Error("Backup contains too many entries.");
    }
    for (const file of snapshotFiles) files.push(file);
  }

  const manifest = createBackupManifest(files, createdAt);
  const fileMap = new Map(files.map((file) => [file.path, file.content]));
  const verification = verifyBackupFiles(manifest, fileMap);
  if (!verification.valid) {
    throw new Error(`Backup bundle failed self-verification: ${verification.errors.join("; ")}`);
  }
  return { manifest, files: fileMap };
}

/**
 * Adapt the durable SQLite session store into a consistent snapshot source.
 * A private temporary directory is used for VACUUM INTO output and removed
 * after its bytes are read; the live database and its WAL/SHM files are never
 * copied directly. In-memory SQLite stores reject this operation explicitly.
 */
export function sqliteSessionBackupSource(store: SqliteSessionStore): BackupSnapshotSource {
  return {
    name: "sessions-sqlite",
    async snapshot() {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sofia-backup-session-"));
      try {
        if (process.platform !== "win32") await fs.chmod(directory, 0o700);
        const destination = path.join(directory, "sessions.sqlite");
        store.createConsistentSnapshot(destination);
        const content = await fs.readFile(destination);
        return [{ path: "sessions/sessions.sqlite", content }];
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Adapt the existing file-backed project-memory store into an explicit backup
 * source. Missing memory is represented as an empty source, not an error.
 */
export function projectMemoryBackupSource(store: FileProjectMemoryStore): BackupSnapshotSource {
  return {
    name: "project-memory",
    async snapshot() {
      const snapshot = await store.backupSnapshot();
      return snapshot ? [snapshot] : [];
    },
  };
}

/**
 * Adapt one explicitly selected user's file-backed memory into a backup
 * source. The source name is hashed so user identifiers are not exposed in
 * diagnostics or manifests; callers must opt in each user independently.
 */
export function userMemoryBackupSource(store: FileUserMemoryStore, userId: string): BackupSnapshotSource {
  if (typeof userId !== "string" || !userId.trim() || userId.length > 512) {
    throw new Error("A valid user identity is required for user memory backup.");
  }
  const identityKey = createHash("sha256").update(userId.trim()).digest("hex");
  return {
    name: `user-memory-${identityKey}`,
    async snapshot() {
      const snapshot = await store.backupSnapshot(userId);
      return snapshot ? [snapshot] : [];
    },
  };
}

/** Verify bundle bytes against the manifest before any future restore step. */
export function verifyBackupBundle(bundle: unknown): BackupBundleVerification {
  if (typeof bundle !== "object" || bundle === null || !("manifest" in bundle) ||
      !("files" in bundle) || !(bundle.files instanceof Map)) {
    return { valid: false, errors: ["Invalid backup bundle shape."], verifiedFiles: 0, verifiedBytes: 0 };
  }
  const result = verifyBackupFiles(bundle.manifest, bundle.files as ReadonlyMap<string, Uint8Array>);
  return result;
}
