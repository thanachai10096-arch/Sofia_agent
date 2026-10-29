import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { BackupBundle, BackupRestoreTargetAdapter } from "./backup-coordinator.js";

type FileRollbackSnapshot = Map<string, Uint8Array | null>;

function destinationFor(root: string, relativePath: string): string {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\\") ||
      relativePath.startsWith("/") || relativePath.split("/").some((part) =>
        !part || part === "." || part === ".." || part.includes(":"))) {
    throw new Error("Restore adapter rejected an unsafe relative path.");
  }
  const destination = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, destination);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Restore adapter path escapes or targets the root directory.");
  }
  return destination;
}

/** Reject symlinked path components and non-regular existing destination files. */
async function assertSafeDestination(root: string, relativePath: string): Promise<string> {
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Restore destination root must be an existing real directory.");
  }
  const destination = destinationFor(root, relativePath);
  const parts = path.relative(root, destination).split(path.sep);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    let info;
    try { info = await fs.lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error("Restore destination must not traverse symbolic links.");
    const final = index === parts.length - 1;
    if (final ? !info.isFile() : !info.isDirectory()) {
      throw new Error(final
        ? "Restore destination exists but is not a regular file."
        : "Restore destination parent exists but is not a directory.");
    }
  }
  return destination;
}

async function atomicWrite(destination: string, bytes: Uint8Array): Promise<void> {
  const directory = path.dirname(destination);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
  const temporary = path.join(directory, ".sofia-restore-" + randomUUID() + ".tmp");
  try {
    await fs.writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/**
 * A conservative adapter for file-backed stores whose backup entries are
 * regular files under one existing root. It writes only explicitly assigned
 * paths, rejects symlink traversal, uses same-directory atomic replacement,
 * and captures byte-for-byte rollback snapshots before any writes.
 *
 * This is suitable for file-backed memory stores, not an open SQLite database:
 * SQLite must be restored through a database-aware adapter with a lifecycle
 * boundary that closes/reopens the database and handles WAL sidecars.
 */
export function directoryBackupRestoreAdapter(
  name: string,
  rootDirectory: string,
  assignedPaths: readonly string[],
): BackupRestoreTargetAdapter {
  const root = path.resolve(rootDirectory);
  const paths = [...assignedPaths];
  if (!name.trim()) throw new Error("Restore adapter name is required.");
  if (new Set(paths).size !== paths.length) throw new Error("Restore adapter paths must be unique.");

  return {
    name,
    paths,
    async preflight(bundle, selectedPaths) {
      if (selectedPaths.length !== paths.length ||
          selectedPaths.some((item, index) => item !== [...paths].sort()[index]) ||
          [...paths].sort().some((item, index) => item !== [...selectedPaths].sort()[index])) {
        throw new Error("Restore adapter selection does not match its configured paths.");
      }
      for (const relativePath of paths) {
        if (!bundle.manifest.entries.some((entry) => entry.path === relativePath) ||
            !bundle.files.has(relativePath)) {
          throw new Error("Restore adapter path is not present in the verified backup bundle.");
        }
        await assertSafeDestination(root, relativePath);
      }
    },
    async captureRollback() {
      const snapshot: FileRollbackSnapshot = new Map();
      for (const relativePath of paths) {
        const destination = await assertSafeDestination(root, relativePath);
        try { snapshot.set(relativePath, await fs.readFile(destination)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") snapshot.set(relativePath, null);
          else throw error;
        }
      }
      return snapshot;
    },
    async apply(bundle: BackupBundle, selectedPaths) {
      for (const relativePath of selectedPaths) {
        const destination = await assertSafeDestination(root, relativePath);
        const bytes = bundle.files.get(relativePath);
        if (!bytes) throw new Error("Restore bundle bytes missing for assigned path.");
        await atomicWrite(destination, bytes);
      }
    },
    async rollback(rawSnapshot) {
      if (!(rawSnapshot instanceof Map)) throw new Error("Invalid file restore rollback snapshot.");
      const snapshot = rawSnapshot as FileRollbackSnapshot;
      for (const relativePath of [...paths].reverse()) {
        if (!snapshot.has(relativePath)) throw new Error("Rollback snapshot is incomplete.");
        const destination = await assertSafeDestination(root, relativePath);
        const previous = snapshot.get(relativePath);
        if (previous === null) {
          await fs.rm(destination, { force: true });
        } else if (previous instanceof Uint8Array) {
          await atomicWrite(destination, previous);
        } else {
          throw new Error("Rollback snapshot contains an invalid file value.");
        }
      }
    },
  };
}
