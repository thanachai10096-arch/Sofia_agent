import { randomUUID } from "node:crypto";
import type { WorkspaceRuntime } from "../platform/runtime.js";

export interface Checkpoint {
  id: string;
  revision: string;
  files: Record<string, string | null>;
  trackedFiles: string[];
  untrackedFiles: string[];
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
    if (trackedResult.code !== 0) throw new Error(trackedResult.stderr || "Unable to list tracked files");

    const statusResult = await this.runtime.git([
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    if (statusResult.code !== 0) throw new Error(statusResult.stderr || "Unable to inspect workspace");

    const trackedFiles = trackedResult.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const statusLines = statusResult.stdout.split(/\r?\n/).filter(Boolean);
    const untrackedFiles = statusLines
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3).trim())
      .filter(Boolean);

    const dirtyTracked = new Set(
      statusLines
        .filter((line) => !line.startsWith("?? "))
        .map((line) => line.slice(3).trim())
        .filter(Boolean),
    );

    const files: Record<string, string | null> = {};
    for (const file of [...dirtyTracked, ...untrackedFiles]) {
      try {
        files[file] = await this.runtime.readFile(file);
      } catch {
        files[file] = null;
      }
    }

    const head = await this.runtime.git(["rev-parse", "HEAD"]);
    const revision = head.code === 0 ? head.stdout.trim() : "no-git-head";
    const checkpoint: Checkpoint = {
      id: randomUUID(),
      revision,
      files,
      trackedFiles,
      untrackedFiles,
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
