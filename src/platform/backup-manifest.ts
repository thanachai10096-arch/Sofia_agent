import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

/**
 * Portable integrity metadata for future Sofia state backup/restore workflows.
 * This module deliberately does not read files, extract archives, or mutate state.
 */
export const SOFIA_BACKUP_FORMAT_VERSION = 1;
export const MAX_BACKUP_MANIFEST_ENTRIES = 10_000;
export const MAX_BACKUP_ENTRY_BYTES = 512 * 1024 * 1024;
export const MAX_BACKUP_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_BACKUP_MANIFEST_JSON_BYTES = 16 * 1024 * 1024;

export interface BackupManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  format: "sofia-agent-backup";
  formatVersion: typeof SOFIA_BACKUP_FORMAT_VERSION;
  createdAt: string;
  entries: BackupManifestEntry[];
}

export interface BackupInputFile {
  path: string;
  content: Uint8Array;
}

export interface BackupVerificationResult {
  valid: boolean;
  errors: string[];
  verifiedFiles: number;
  verifiedBytes: number;
}

function safeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) return false;
  if (value.includes("\\") || value.startsWith("/") || value.includes("\0")) return false;
  if (/^[a-zA-Z]:/u.test(value) || value.startsWith("//")) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Create deterministic, path-safe integrity metadata without touching the filesystem. */
export function createBackupManifest(
  files: readonly BackupInputFile[],
  createdAt = new Date().toISOString(),
): BackupManifest {
  if (!Array.isArray(files) || files.length > MAX_BACKUP_MANIFEST_ENTRIES) {
    throw new Error("Backup contains too many entries.");
  }
  if (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
    throw new Error("Backup createdAt must be a canonical ISO-8601 timestamp.");
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  const entries = files.map(({ path, content }) => {
    if (!safeRelativePath(path)) throw new Error("Backup entry path must be a safe relative POSIX path.");
    if (seen.has(path)) throw new Error("Backup entry paths must be unique.");
    seen.add(path);
    if (!(content instanceof Uint8Array)) throw new TypeError("Backup entry content must be bytes.");
    if (content.byteLength > MAX_BACKUP_ENTRY_BYTES) throw new Error("Backup entry exceeds the maximum allowed size.");
    totalBytes += content.byteLength;
    if (totalBytes > MAX_BACKUP_TOTAL_BYTES) throw new Error("Backup exceeds the maximum allowed total size.");
    return { path, size: content.byteLength, sha256: digest(content) };
  });

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { format: "sofia-agent-backup", formatVersion: SOFIA_BACKUP_FORMAT_VERSION, createdAt, entries };
}

/** Validate untrusted manifest metadata before any restore code considers writing files. */
export function validateBackupManifest(value: unknown): BackupManifest {
  if (!isRecord(value) || value.format !== "sofia-agent-backup") {
    throw new Error("Invalid Sofia backup manifest format.");
  }
  if (value.formatVersion !== SOFIA_BACKUP_FORMAT_VERSION) {
    throw new Error("Unsupported Sofia backup manifest version.");
  }
  if (typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      new Date(value.createdAt).toISOString() !== value.createdAt) {
    throw new Error("Invalid Sofia backup manifest timestamp.");
  }
  if (!Array.isArray(value.entries) || value.entries.length > MAX_BACKUP_MANIFEST_ENTRIES) {
    throw new Error("Invalid Sofia backup manifest entries.");
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  const entries: BackupManifestEntry[] = value.entries.map((entry: unknown) => {
    if (!isRecord(entry) || !safeRelativePath(entry.path)) {
      throw new Error("Backup manifest contains an unsafe path.");
    }
    if (seen.has(entry.path)) throw new Error("Backup manifest contains duplicate paths.");
    seen.add(entry.path);
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0 ||
        (entry.size as number) > MAX_BACKUP_ENTRY_BYTES) {
      throw new Error("Backup manifest contains an invalid entry size.");
    }
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
      throw new Error("Backup manifest contains an invalid SHA-256 digest.");
    }
    totalBytes += entry.size as number;
    if (totalBytes > MAX_BACKUP_TOTAL_BYTES) throw new Error("Backup manifest exceeds the maximum total size.");
    return { path: entry.path, size: entry.size as number, sha256: entry.sha256 };
  });

  return {
    format: "sofia-agent-backup",
    formatVersion: SOFIA_BACKUP_FORMAT_VERSION,
    createdAt: value.createdAt,
    entries,
  };
}


/** Serialize a validated manifest in deterministic path order with a bounded output size. */
export function serializeBackupManifest(value: unknown): string {
  const manifest = validateBackupManifest(value);
  manifest.entries.sort((a, b) => a.path.localeCompare(b.path));
  const json = JSON.stringify(manifest);
  if (Buffer.byteLength(json, "utf8") > MAX_BACKUP_MANIFEST_JSON_BYTES) {
    throw new Error("Backup manifest JSON exceeds the maximum allowed size.");
  }
  return json;
}

/** Parse untrusted manifest JSON with a size limit, then validate its complete schema. */
export function parseBackupManifestJson(input: string): BackupManifest {
  if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > MAX_BACKUP_MANIFEST_JSON_BYTES) {
    throw new Error("Backup manifest JSON exceeds the maximum allowed size.");
  }
  let value: unknown;
  try {
    value = JSON.parse(input) as unknown;
  } catch {
    throw new Error("Backup manifest JSON is malformed.");
  }
  return validateBackupManifest(value);
}

/**
 * Compare manifest entries with supplied file bytes. This does not extract archives
 * or restore files; callers must still enforce filesystem containment and atomic restore.
 */
export function verifyBackupFiles(
  manifestInput: unknown,
  files: ReadonlyMap<string, Uint8Array>,
): BackupVerificationResult {
  const errors: string[] = [];
  let manifest: BackupManifest;
  try {
    manifest = validateBackupManifest(manifestInput);
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : "Invalid backup manifest."],
      verifiedFiles: 0,
      verifiedBytes: 0,
    };
  }

  const expected = new Set(manifest.entries.map((entry) => entry.path));
  for (const suppliedPath of files.keys()) {
    if (!safeRelativePath(suppliedPath)) errors.push("Supplied backup contains an unsafe path.");
    else if (!expected.has(suppliedPath)) errors.push(`Unexpected backup file: ${suppliedPath}`);
  }

  let verifiedFiles = 0;
  let verifiedBytes = 0;
  for (const entry of manifest.entries) {
    const content = files.get(entry.path);
    if (!content) {
      errors.push(`Missing backup file: ${entry.path}`);
      continue;
    }
    if (!(content instanceof Uint8Array)) {
      errors.push(`Invalid backup bytes: ${entry.path}`);
      continue;
    }
    if (content.byteLength !== entry.size) {
      errors.push(`Size mismatch: ${entry.path}`);
      continue;
    }
    if (digest(content) !== entry.sha256) {
      errors.push(`Checksum mismatch: ${entry.path}`);
      continue;
    }
    verifiedFiles += 1;
    verifiedBytes += content.byteLength;
  }

  return { valid: errors.length === 0, errors, verifiedFiles, verifiedBytes };
}
