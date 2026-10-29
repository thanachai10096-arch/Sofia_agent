import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SqliteSessionStore } from "../session/sqlite-store.js";
import type { FileProjectMemoryStore } from "../brain/project-memory.js";
import type { FileUserMemoryStore } from "../brain/user-memory.js";
import {
  createBackupManifest,
  parseBackupManifestJson,
  serializeBackupManifest,
  MAX_BACKUP_ENTRY_BYTES,
  MAX_BACKUP_MANIFEST_ENTRIES,
  MAX_BACKUP_MANIFEST_JSON_BYTES,
  MAX_BACKUP_TOTAL_BYTES,
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

/**
 * Export a verified bundle as a private directory tree. This is a portable
 * directory export, not a compressed archive and not a restore operation.
 * The destination must not exist; a failed export removes only the directory
 * created by this call.
 */
export async function writeBackupBundleDirectory(
  bundle: unknown,
  destinationPath: string,
): Promise<string> {
  const verification = verifyBackupBundle(bundle);
  if (!verification.valid) {
    throw new Error(`Refusing to export an invalid backup bundle: ${verification.errors.join("; ")}`);
  }
  if (typeof destinationPath !== "string" || destinationPath.trim().length === 0) {
    throw new Error("A backup destination path is required.");
  }

  const destination = path.resolve(destinationPath);
  const parent = path.dirname(destination);
  const parentInfo = await fs.lstat(parent).catch(() => undefined);
  if (!parentInfo?.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new Error("Backup destination parent must be an existing real directory.");
  }

  const record = bundle as BackupBundle;
  if (record.files.has("manifest.json")) {
    throw new Error('Backup file path "manifest.json" is reserved for the manifest.');
  }

  await fs.mkdir(destination, { recursive: false, mode: 0o700 });
  try {
    for (const entry of record.manifest.entries) {
      const target = path.join(destination, ...entry.path.split("/"));
      const directory = path.dirname(target);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const content = record.files.get(entry.path);
      if (!content) throw new Error(`Backup file disappeared during export: ${entry.path}`);
      await fs.writeFile(target, content, { flag: "wx", mode: 0o600 });
    }
    await fs.writeFile(
      path.join(destination, "manifest.json"),
      serializeBackupManifest(record.manifest),
      { flag: "wx", mode: 0o600 },
    );
    return destination;
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Read and verify a directory export without following symlinks. This returns
 * verified bytes only; it never writes to a restore target or mutates Sofia state.
 */
export async function readBackupBundleDirectory(sourcePath: string): Promise<BackupBundle> {
  if (typeof sourcePath !== "string" || sourcePath.trim().length === 0) {
    throw new Error("A backup source path is required.");
  }
  const root = path.resolve(sourcePath);
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Backup source must be a real directory.");
  }

  const manifestPath = path.join(root, "manifest.json");
  const manifestInfo = await fs.lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() ||
      manifestInfo.size > MAX_BACKUP_MANIFEST_JSON_BYTES) {
    throw new Error("Backup manifest is missing, unsafe, or too large.");
  }
  const manifestText = await fs.readFile(manifestPath, "utf8");
  const manifest = parseBackupManifestJson(manifestText);
  if (manifest.entries.length > MAX_BACKUP_MANIFEST_ENTRIES) {
    throw new Error("Backup contains too many entries.");
  }

  const expectedFiles = new Set<string>(["manifest.json", ...manifest.entries.map((entry) => entry.path)]);
  const expectedDirectories = new Set<string>();
  for (const entry of manifest.entries) {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      expectedDirectories.add(parts.slice(0, index).join("/"));
    }
  }
  let totalBytes = 0;
  const files = new Map<string, Uint8Array>();

  // Reject extra files, empty/unlisted directories, and all symlinks rather
  // than silently accepting payloads not represented by the manifest.
  const visit = async (directory: string, relative = ""): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const item of entries) {
      const rel = relative ? `${relative}/${item.name}` : item.name;
      const absolute = path.join(directory, item.name);
      const info = await fs.lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Backup directory contains a symlink: ${rel}`);
      if (info.isDirectory()) {
        if (!expectedDirectories.has(rel)) throw new Error(`Unexpected backup directory: ${rel}`);
        await visit(absolute, rel);
        continue;
      }
      if (!info.isFile()) throw new Error(`Backup directory contains a non-regular entry: ${rel}`);
      if (!expectedFiles.has(rel)) throw new Error(`Unexpected backup file: ${rel}`);
    }
  };
  await visit(root);

  for (const entry of manifest.entries) {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_BACKUP_ENTRY_BYTES) {
      throw new Error(`Backup entry size is outside supported limits: ${entry.path}`);
    }
    totalBytes += entry.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_BACKUP_TOTAL_BYTES) {
      throw new Error("Backup exceeds the total supported size.");
    }
    const parts = entry.path.split("/");
    let current = root;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      const info = await fs.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`Backup path contains an unsafe directory: ${entry.path}`);
      }
    }
    const absolute = path.join(root, ...parts);
    const info = await fs.lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.size) {
      throw new Error(`Backup entry is missing or has an invalid size: ${entry.path}`);
    }
    files.set(entry.path, await fs.readFile(absolute));
  }

  const verification = verifyBackupFiles(manifest, files);
  if (!verification.valid) {
    throw new Error(`Backup directory verification failed: ${verification.errors.join("; ")}`);
  }
  return { manifest, files };
}

/**
 * Stage a verified bundle in a newly-created private directory for a future
 * restore preflight. This does not apply data to any live store. The caller
 * must invoke cleanup() when the staged bytes are no longer needed.
 */
export async function stageBackupBundleForRestore(
  bundle: unknown,
  stagingParent: string,
): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const verification = verifyBackupBundle(bundle);
  if (!verification.valid) {
    throw new Error(`Refusing to stage an invalid backup bundle: ${verification.errors.join("; ")}`);
  }
  if (typeof stagingParent !== "string" || stagingParent.trim().length === 0) {
    throw new Error("A restore staging parent directory is required.");
  }
  const parent = path.resolve(stagingParent);
  const parentInfo = await fs.lstat(parent).catch(() => undefined);
  if (!parentInfo?.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new Error("Restore staging parent must be an existing real directory.");
  }

  const privateRoot = await fs.mkdtemp(path.join(parent, ".sofia-restore-stage-"));
  try {
    if (process.platform !== "win32") await fs.chmod(privateRoot, 0o700);
    const directory = path.join(privateRoot, "bundle");
    await writeBackupBundleDirectory(bundle, directory);
    // Read it back from disk so the caller receives a verified staged copy,
    // not just the original in-memory map.
    await readBackupBundleDirectory(directory);
    let cleaned = false;
    return {
      directory,
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await fs.rm(privateRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.rm(privateRoot, { recursive: true, force: true });
    throw error;
  }
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
