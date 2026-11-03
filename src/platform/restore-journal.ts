import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MAX_BACKUP_MANIFEST_ENTRIES } from "./backup-manifest.js";

/**
 * Durable intent record for restore coordination. It deliberately stores
 * metadata and content digests only: rollback bytes remain in a separately
 * managed, protected snapshot store.
 */
export type RestoreJournalPhase =
  | "prepared"
  | "applying"
  | "rollback_required"
  | "rolling_back"
  | "committed"
  | "rolled_back"
  | "rollback_failed";

export type RestoreJournalTargetPhase =
  | "pending"
  | "applying"
  | "applied"
  | "rollback_pending"
  | "rolled_back"
  | "rollback_failed";

export interface RestoreJournalTarget {
  name: string;
  paths: string[];
  phase: RestoreJournalTargetPhase;
  /** Opaque reference to a durable rollback snapshot; never snapshot contents. */
  rollbackSnapshotRef?: string;
  /** SHA-256 of the rollback snapshot bytes, when the adapter can provide it. */
  rollbackSnapshotSha256?: string;
}

export interface RestoreJournalRecord {
  format: "sofia-agent-restore-journal";
  version: 1;
  transactionId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  phase: RestoreJournalPhase;
  /** Hash of the verified source manifest; no user data or secret values. */
  manifestSha256: string;
  targets: RestoreJournalTarget[];
  failureCode?: string;
}

export interface RestoreJournalStore {
  /** Persist revision zero. Must fail if this transaction already exists. */
  create(record: RestoreJournalRecord): Promise<void>;
  /**
   * Append a full immutable revision. Implementations must compare the latest
   * revision with expectedRevision and fail on concurrent/stale writers.
   */
  append(record: RestoreJournalRecord, expectedRevision: number): Promise<void>;
  /** Return the latest durable revision, if any. */
  read(transactionId: string): Promise<RestoreJournalRecord | undefined>;
  /** Enumerate latest revisions for startup recovery inspection. */
  list(): Promise<RestoreJournalRecord[]>;
}

const TRANSACTION_ID = /^[a-f0-9-]{16,64}$/iu;
const SHA256 = /^[a-f0-9]{64}$/iu;
const PHASES = new Set<RestoreJournalPhase>([
  "prepared", "applying", "rollback_required", "rolling_back",
  "committed", "rolled_back", "rollback_failed",
]);
const TARGET_PHASES = new Set<RestoreJournalTargetPhase>([
  "pending", "applying", "applied", "rollback_pending", "rolled_back", "rollback_failed",
]);
const TERMINAL_PHASES = new Set<RestoreJournalPhase>(["committed", "rolled_back", "rollback_failed"]);

function canonicalTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function assertSafeToken(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 ||
      value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Restore journal ${label} is invalid.`);
  }
}

export function validateRestoreJournalRecord(value: unknown): RestoreJournalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Restore journal record must be an object.");
  }
  const record = value as Partial<RestoreJournalRecord>;
  if (record.format !== "sofia-agent-restore-journal" || record.version !== 1) {
    throw new Error("Unsupported restore journal format or version.");
  }
  if (typeof record.transactionId !== "string" || !TRANSACTION_ID.test(record.transactionId)) {
    throw new Error("Restore journal transaction ID is invalid.");
  }
  if (!Number.isSafeInteger(record.revision) || (record.revision ?? -1) < 0) {
    throw new Error("Restore journal revision is invalid.");
  }
  if (typeof record.createdAt !== "string" || !canonicalTimestamp(record.createdAt) ||
      typeof record.updatedAt !== "string" || !canonicalTimestamp(record.updatedAt) ||
      Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
    throw new Error("Restore journal timestamps are invalid.");
  }
  if (typeof record.phase !== "string" || !PHASES.has(record.phase)) {
    throw new Error("Restore journal phase is invalid.");
  }
  if (typeof record.manifestSha256 !== "string" || !SHA256.test(record.manifestSha256)) {
    throw new Error("Restore journal manifest digest is invalid.");
  }
  if (!Array.isArray(record.targets) || record.targets.length > MAX_BACKUP_MANIFEST_ENTRIES) {
    throw new Error("Restore journal targets are invalid.");
  }
  const names = new Set<string>();
  const paths = new Set<string>();
  const portablePaths = new Set<string>();
  for (const target of record.targets) {
    if (!target || typeof target !== "object") throw new Error("Restore journal target is invalid.");
    assertSafeToken(target.name, "target name");
    if (names.has(target.name)) throw new Error("Restore journal target names must be unique.");
    names.add(target.name);
    if (!Array.isArray(target.paths) || target.paths.length === 0) {
      throw new Error("Restore journal target paths are invalid.");
    }
    for (const item of target.paths) {
      assertSafeToken(item, "target path");
      if (item.startsWith("/") || item.includes("\\") || item.includes(":") || item.split("/").some((part) => !part || part === "." || part === "..")) {
        throw new Error("Restore journal contains an unsafe target path.");
      }
      if (paths.has(item)) throw new Error("Restore journal target paths overlap.");
      paths.add(item);

      // Journal files are durable input at startup. Enforce the same portable
      // destination rules as backup manifests, even if a record was tampered
      // with after it was originally created.
      const portable = item.normalize("NFC").toLowerCase();
      if (portablePaths.has(portable)) {
        throw new Error("Restore journal target paths collide on portable filesystems.");
      }
      const parts = portable.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        if (portablePaths.has(parts.slice(0, index).join("/"))) {
          throw new Error("Restore journal target paths conflict as files and directories.");
        }
      }
      for (const existing of portablePaths) {
        if (existing.startsWith(portable + "/")) {
          throw new Error("Restore journal target paths conflict as files and directories.");
        }
      }
      portablePaths.add(portable);
    }
    if (typeof target.phase !== "string" || !TARGET_PHASES.has(target.phase)) {
      throw new Error("Restore journal target phase is invalid.");
    }
    if (target.rollbackSnapshotRef !== undefined) {
      assertSafeToken(target.rollbackSnapshotRef, "snapshot reference");
      if (!/^[a-z0-9._:/-]+$/iu.test(target.rollbackSnapshotRef)) {
        throw new Error("Restore journal snapshot reference contains unsupported characters.");
      }
    }
    if (target.rollbackSnapshotSha256 !== undefined &&
        (typeof target.rollbackSnapshotSha256 !== "string" || !SHA256.test(target.rollbackSnapshotSha256))) {
      throw new Error("Restore journal snapshot digest is invalid.");
    }
  }
  if (record.failureCode !== undefined) {
    assertSafeToken(record.failureCode, "failure code");
    if (!/^[a-z0-9_:-]{1,64}$/iu.test(record.failureCode)) {
      throw new Error("Restore journal failure code is invalid.");
    }
  }
  return structuredClone(record as RestoreJournalRecord);
}

export function createRestoreJournalRecord(input: {
  transactionId: string;
  createdAt: string;
  manifestSha256: string;
  targets: readonly Omit<RestoreJournalTarget, "phase">[];
}): RestoreJournalRecord {
  return validateRestoreJournalRecord({
    format: "sofia-agent-restore-journal",
    version: 1,
    transactionId: input.transactionId,
    revision: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    phase: "prepared",
    manifestSha256: input.manifestSha256,
    targets: input.targets.map((target) => ({ ...target, paths: [...target.paths], phase: "pending" })),
  });
}

/**
 * Apply a legal state transition and return a new immutable revision. The
 * transition helper never executes adapters or claims that rollback occurred.
 */
export function advanceRestoreJournal(
  currentValue: RestoreJournalRecord,
  update: {
    phase: RestoreJournalPhase;
    updatedAt: string;
    targets?: readonly RestoreJournalTarget[];
    failureCode?: string;
  },
): RestoreJournalRecord {
  const current = validateRestoreJournalRecord(currentValue);
  if (TERMINAL_PHASES.has(current.phase)) {
    throw new Error(`Restore journal is terminal: ${current.phase}`);
  }
  if (!canonicalTimestamp(update.updatedAt) || Date.parse(update.updatedAt) < Date.parse(current.updatedAt)) {
    throw new Error("Restore journal update timestamp is invalid.");
  }
  const allowed: Record<RestoreJournalPhase, readonly RestoreJournalPhase[]> = {
    prepared: ["applying", "rollback_required"],
    applying: ["applying", "rollback_required", "committed"],
    rollback_required: ["rolling_back", "rollback_failed"],
    rolling_back: ["rolling_back", "rolled_back", "rollback_failed"],
    committed: [],
    rolled_back: [],
    rollback_failed: [],
  };
  if (!allowed[current.phase].includes(update.phase)) {
    throw new Error(`Illegal restore journal transition: ${current.phase} -> ${update.phase}`);
  }
  const next = validateRestoreJournalRecord({
    ...current,
    revision: current.revision + 1,
    updatedAt: update.updatedAt,
    phase: update.phase,
    targets: update.targets ? update.targets.map((target) => ({ ...target, paths: [...target.paths] })) : current.targets,
    ...(update.failureCode ? { failureCode: update.failureCode } : {}),
  });
  if (next.targets.length !== current.targets.length ||
      next.targets.some((target, index) => target.name !== current.targets[index]?.name ||
        target.paths.join("\n") !== current.targets[index]?.paths.join("\n"))) {
    throw new Error("Restore journal target ownership is immutable.");
  }
  return next;
}

function transactionDirectory(root: string, transactionId: string): string {
  if (!TRANSACTION_ID.test(transactionId)) throw new Error("Restore journal transaction ID is invalid.");
  return path.join(root, createHash("sha256").update(transactionId).digest("hex"));
}

function revisionName(revision: number): string {
  return revision.toString().padStart(10, "0") + ".json";
}

async function writeExclusiveRecord(directory: string, file: string, record: RestoreJournalRecord): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, "wx", 0o600);
    await handle.writeFile(JSON.stringify(record), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Persist the directory entry where supported. Windows does not expose
    // portable directory fsync semantics, so file data is still synced there.
    if (process.platform !== "win32") {
      const directoryHandle = await fs.open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(file, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Append-only local journal. Each revision is a new exclusive-create file;
 * no prior record is overwritten. Concurrent writers race on the same next
 * revision and exactly one can win. A failed writer must reload and reconcile.
 */
export class FileRestoreJournalStore implements RestoreJournalStore {
  private readonly root: string;

  constructor(root: string) {
    if (typeof root !== "string" || !root.trim()) throw new Error("Restore journal root is required.");
    this.root = path.resolve(root);
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Restore journal root must be a real directory.");
    if (process.platform !== "win32") await fs.chmod(this.root, 0o700);
  }

  private async readDirectory(directory: string): Promise<RestoreJournalRecord | undefined> {
    const info = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) return undefined;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Restore journal transaction path is unsafe.");
    const names = (await fs.readdir(directory)).filter((name) => /^\d{10}\.json$/u.test(name)).sort();
    if (names.length === 0) return undefined;
    const latestName = names[names.length - 1]!;
    const file = path.join(directory, latestName);
    const fileInfo = await fs.lstat(file);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > 1024 * 1024) {
      throw new Error("Restore journal revision file is unsafe or too large.");
    }
    const parsed = validateRestoreJournalRecord(JSON.parse(await fs.readFile(file, "utf8")));
    if (revisionName(parsed.revision) !== latestName) throw new Error("Restore journal revision filename mismatch.");
    return parsed;
  }

  async create(recordValue: RestoreJournalRecord): Promise<void> {
    const record = validateRestoreJournalRecord(recordValue);
    if (record.revision !== 0 || record.phase !== "prepared") {
      throw new Error("A restore journal must start at revision zero in prepared phase.");
    }
    await this.ensureRoot();
    const directory = transactionDirectory(this.root, record.transactionId);
    await fs.mkdir(directory, { mode: 0o700 });
    try {
      await writeExclusiveRecord(directory, path.join(directory, revisionName(0)), record);
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async append(recordValue: RestoreJournalRecord, expectedRevision: number): Promise<void> {
    const record = validateRestoreJournalRecord(recordValue);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
        record.revision !== expectedRevision + 1) {
      throw new Error("Restore journal append revision is invalid.");
    }
    await this.ensureRoot();
    const directory = transactionDirectory(this.root, record.transactionId);
    const current = await this.readDirectory(directory);
    if (!current || current.revision !== expectedRevision) {
      throw new Error("Restore journal revision conflict; reload before appending.");
    }
    // Exclusive create prevents overwriting an existing revision. If another
    // process won the same revision after our read, this write fails closed.
    await writeExclusiveRecord(directory, path.join(directory, revisionName(record.revision)), record);
  }

  async read(transactionId: string): Promise<RestoreJournalRecord | undefined> {
    await this.ensureRoot();
    return this.readDirectory(transactionDirectory(this.root, transactionId));
  }

  async list(): Promise<RestoreJournalRecord[]> {
    await this.ensureRoot();
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const records: RestoreJournalRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue;
      const record = await this.readDirectory(path.join(this.root, entry.name));
      if (record) records.push(record);
    }
    return records.sort((a, b) => a.transactionId < b.transactionId ? -1 : a.transactionId > b.transactionId ? 1 : 0);
  }
}


export type RestoreJournalRecoveryStatus =
  | "not_started"
  | "completed"
  | "interrupted"
  | "rollback_incomplete";

export interface RestoreJournalRecoveryInspection {
  transactionId: string;
  revision: number;
  phase: RestoreJournalPhase;
  status: RestoreJournalRecoveryStatus;
  requiresOperator: boolean;
  targets: Array<{ name: string; phase: RestoreJournalTargetPhase }>;
}

/**
 * Read-only startup inspection. It never resumes a restore or mutates targets:
 * incomplete transactions are surfaced for an explicit recovery workflow.
 */
export async function inspectRestoreJournalRecovery(
  store: RestoreJournalStore,
): Promise<RestoreJournalRecoveryInspection[]> {
  const records = await store.list();
  return records.map((value) => {
    const record = validateRestoreJournalRecord(value);
    const status: RestoreJournalRecoveryStatus =
      record.phase === "prepared" ? "not_started" :
      record.phase === "committed" || record.phase === "rolled_back" ? "completed" :
      record.phase === "rollback_failed" ? "rollback_incomplete" : "interrupted";
    return {
      transactionId: record.transactionId,
      revision: record.revision,
      phase: record.phase,
      status,
      requiresOperator: status === "interrupted" || status === "rollback_incomplete",
      targets: record.targets.map(({ name, phase }) => ({ name, phase })),
    };
  });
}
