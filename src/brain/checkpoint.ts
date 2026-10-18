import { randomUUID } from "node:crypto";
import type { WorkspaceRuntime } from "../platform/runtime.js";

export interface Checkpoint {
  id: string;
  revision: string;
  files: Record<string, string | null>;
  trackedFiles: string[];
  untrackedFiles: string[];
  /** False when the workspace is not a usable Git checkout. */
  gitAvailable?: boolean;
}

export interface CheckpointManager {
  create(signal: AbortSignal): Promise<Checkpoint>;
  rollback(checkpointId: string, signal: AbortSignal): Promise<{ restoredFiles: string[] }>;
}

export class RuntimeCheckpointManager implements CheckpointManager {
  private readonly checkpoints = new Map<string, Checkpoint>();

  constructor(private readonly runtime: WorkspaceRuntime) {}

  async create(signal: AbortSignal): Promise<Checkpoint> {
    signal.throwIfAborted();

    const trackedResult = await this.runtime.git(["ls-files"]);
    const statusResult = trackedResult.code === 0
      ? await this.runtime.git(["status", "--porcelain", "--untracked-files=all"])
      : { stdout: "", stderr: trackedResult.stderr, code: trackedResult.code };
    const gitAvailable = trackedResult.code === 0 && statusResult.code === 0;

    let trackedFiles: string[] = [];
    let untrackedFiles: string[] = [];
    let files: Record<string, string | null> = {};

    if (gitAvailable) {
      trackedFiles = trackedResult.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      const statusLines = statusResult.stdout.split(/\r?\n/).filter(Boolean);
      untrackedFiles = statusLines.filter((line) => line.startsWith("?? "))
        .map((line) => line.slice(3).trim()).filter(Boolean);
      const dirtyTracked = new Set(statusLines.filter((line) => !line.startsWith("?? "))
        .map((line) => line.slice(3).trim()).filter(Boolean));
      for (const file of [...dirtyTracked, ...untrackedFiles]) {
        try { files[file] = await this.runtime.readFile(file); }
        catch { files[file] = null; }
      }
    } else {
      // Railway/container deployments may omit .git. Snapshot readable workspace
      // files so a missing Git checkout does not prevent the agent from starting.
      const ignored = new Set([".git", "node_modules", "dist", ".next", "coverage"]);
      const secret = /^(?:\.env(?:\..*)?|id_(?:rsa|ed25519)|credentials(?:\.json)?|secrets?(?:\.json|\.ya?ml)?|.*\.(?:pem|key|p12|pfx))$/i;
      const walk = async (directory: string, prefix = ""): Promise<void> => {
        let entries: string[];
        try { entries = await this.runtime.listFiles(directory); } catch { return; }
        for (const entry of entries) {
          if (ignored.has(entry) || secret.test(entry)) continue;
          const relative = prefix ? prefix + "/" + entry : entry;
          let isDirectory = false;
          try { await this.runtime.listFiles(relative); isDirectory = true; } catch { /* likely a file */ }
          if (isDirectory) await walk(relative, relative);
          else {
            try { files[relative] = await this.runtime.readFile(relative); }
            catch { /* skip unreadable/binary files */ }
          }
        }
      };
      await walk(".");
      trackedFiles = Object.keys(files).sort();
    }

    const head = gitAvailable ? await this.runtime.git(["rev-parse", "HEAD"]) : { stdout: "", stderr: "", code: 1 };
    const revision = head.code === 0 ? head.stdout.trim() : "no-git-head";
    const checkpoint: Checkpoint = {
      id: randomUUID(),
      revision,
      files,
      trackedFiles,
      untrackedFiles,
      gitAvailable,
    };

    this.checkpoints.set(checkpoint.id, checkpoint);
    return checkpoint;
  }

  remember(checkpoint: Checkpoint): void {
    this.checkpoints.set(checkpoint.id, checkpoint);
  }

  async rollback(checkpointId: string, signal: AbortSignal): Promise<{ restoredFiles: string[] }> {
    signal.throwIfAborted();
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) throw new Error("Unknown checkpoint");

    if (checkpoint.gitAvailable === false) {
      const restoredFiles: string[] = [];
      for (const [file, content] of Object.entries(checkpoint.files)) {
        signal.throwIfAborted();
        if (content !== null) {
          await this.runtime.writeFile(file, content);
          restoredFiles.push(file);
        }
      }
      // Without Git there is no safe, portable delete operation on WorkspaceRuntime;
      // restore snapshotted contents but never attempt broad filesystem cleanup.
      return { restoredFiles };
    }

    const status = await this.runtime.git(["status", "--porcelain", "--untracked-files=all"]);
    if (status.code !== 0) throw new Error(status.stderr || "Unable to inspect workspace");

    const currentUntracked = status.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3).trim())
      .filter(Boolean);

    const restoredFiles: string[] = [];
    const currentPaths = status.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);

    const baselineDirty = new Set(Object.keys(checkpoint.files));
    const restoreTracked = currentPaths.filter((file) => !checkpoint.untrackedFiles.includes(file));
    const baselineDirtyTracked = restoreTracked.filter((file) => Object.prototype.hasOwnProperty.call(checkpoint.files, file) && !checkpoint.untrackedFiles.includes(file));
    const cleanOrNewTracked = restoreTracked.filter((file) => !baselineDirtyTracked.includes(file));

    if (cleanOrNewTracked.length > 0) {
      const result = await this.runtime.git(["restore", "--worktree", "--staged", "--", ...cleanOrNewTracked]);
      if (result.code !== 0) throw new Error(result.stderr || "Unable to restore tracked files");
      restoredFiles.push(...cleanOrNewTracked);
    }

    for (const file of baselineDirtyTracked) {
      const content = checkpoint.files[file] ?? null;
      if (content === null) {
        const result = await this.runtime.git(["restore", "--worktree", "--staged", "--", file]);
        if (result.code !== 0) throw new Error(result.stderr || "Unable to restore missing tracked file");
      } else {
        await this.runtime.writeFile(file, content);
        await this.runtime.git(["restore", "--staged", "--", file]);
      }
      restoredFiles.push(file);
    }

    for (const file of checkpoint.untrackedFiles) {
      signal.throwIfAborted();
      const content = checkpoint.files[file] ?? null;
      if (content === null) {
        await this.runtime.git(["clean", "-f", "--", file]);
      } else {
        await this.runtime.writeFile(file, content);
      }
      restoredFiles.push(file);
    }

    for (const file of currentUntracked) {
      if (!baselineDirty.has(file)) {
        const result = await this.runtime.git(["clean", "-f", "--", file]);
        if (result.code !== 0) throw new Error(result.stderr || "Unable to remove generated file");
        restoredFiles.push(file);
      }
    }

    return { restoredFiles: [...new Set(restoredFiles)] };
  }
}
