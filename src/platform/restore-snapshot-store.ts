import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const TRANSACTION_ID = /^[a-f0-9-]{16,64}$/iu;
const SHA256 = /^[a-f0-9]{64}$/iu;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024 * 1024;

export interface PersistedRestoreSnapshot {
  /** Opaque, root-relative reference; callers must not interpret it as a path. */
  ref: string;
  sha256: string;
  byteLength: number;
}

export interface RestoreSnapshotStore {
  write(transactionId: string, targetName: string, bytes: Uint8Array): Promise<PersistedRestoreSnapshot>;
  read(ref: string, expectedSha256: string): Promise<Uint8Array>;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertIdentity(transactionId: string, targetName: string): void {
  if (!TRANSACTION_ID.test(transactionId)) throw new Error("Restore snapshot transaction ID is invalid.");
  if (typeof targetName !== "string" || targetName.length < 1 || targetName.length > 128 ||
      targetName.trim() !== targetName || !/^[a-z0-9._-]+$/iu.test(targetName)) {
    throw new Error("Restore snapshot target name is invalid.");
  }
}

function assertReference(ref: string): void {
  if (typeof ref !== "string" || !/^[a-f0-9]{64}\/[a-f0-9]{64}\.snapshot$/u.test(ref)) {
    throw new Error("Restore snapshot reference is invalid.");
  }
}

/**
 * Private append-only snapshot storage. Snapshot bytes are separate from the
 * intent journal and are verified on every read before being returned.
 */
export class FileRestoreSnapshotStore implements RestoreSnapshotStore {
  private readonly root: string;

  constructor(root: string) {
    if (typeof root !== "string" || !root.trim()) throw new Error("Restore snapshot root is required.");
    this.root = path.resolve(root);
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Restore snapshot root must be a real directory.");
    }
    if (process.platform !== "win32") await fs.chmod(this.root, 0o700);
  }

  private resolveReference(ref: string): string {
    assertReference(ref);
    return path.join(this.root, ...ref.split("/"));
  }

  async write(
    transactionId: string,
    targetName: string,
    bytes: Uint8Array,
  ): Promise<PersistedRestoreSnapshot> {
    assertIdentity(transactionId, targetName);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_SNAPSHOT_BYTES) {
      throw new Error("Restore snapshot bytes are invalid or exceed the size limit.");
    }
    await this.ensureRoot();
    const transactionKey = digest(Buffer.from(transactionId, "utf8"));
    const targetKey = digest(Buffer.from(targetName, "utf8"));
    const ref = `${transactionKey}/${targetKey}.snapshot`;
    const directory = path.join(this.root, transactionKey);
    await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const directoryInfo = await fs.lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new Error("Restore snapshot transaction directory is unsafe.");
    }
    if (process.platform !== "win32") await fs.chmod(directory, 0o700);

    const file = this.resolveReference(ref);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(file, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
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
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const existing = await this.read(ref, digest(bytes));
        if (Buffer.compare(Buffer.from(existing), Buffer.from(bytes)) === 0) {
          return { ref, sha256: digest(bytes), byteLength: bytes.byteLength };
        }
        throw new Error("Restore snapshot already exists with different content.");
      }
      await fs.rm(file, { force: true }).catch(() => undefined);
      throw error;
    }
    return { ref, sha256: digest(bytes), byteLength: bytes.byteLength };
  }

  async read(ref: string, expectedSha256: string): Promise<Uint8Array> {
    if (!SHA256.test(expectedSha256)) throw new Error("Restore snapshot expected digest is invalid.");
    await this.ensureRoot();
    const file = this.resolveReference(ref);
    const directory = path.dirname(file);
    const directoryInfo = await fs.lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new Error("Restore snapshot transaction directory is unsafe.");
    }
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SNAPSHOT_BYTES) {
      throw new Error("Restore snapshot file is unsafe or too large.");
    }
    const bytes = await fs.readFile(file);
    if (digest(bytes) !== expectedSha256) {
      throw new Error("Restore snapshot digest verification failed.");
    }
    return new Uint8Array(bytes);
  }
}
