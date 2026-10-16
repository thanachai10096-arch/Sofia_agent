import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkspaceRuntime } from "../platform/runtime.js";
import type { Checkpoint, CheckpointManager } from "./checkpoint.js";
import { RuntimeCheckpointManager } from "./checkpoint.js";

interface CheckpointStore {
  save(checkpoint: Checkpoint): Promise<void>;
  load(id: string): Promise<Checkpoint | undefined>;
}

class FileCheckpointStore implements CheckpointStore {
  private readonly directory: string;

  constructor(namespace: string, root = path.join(os.tmpdir(), "sofia-agents-checkpoints")) {
    const key = createHash("sha256").update(namespace).digest("hex");
    this.directory = path.join(root, key);
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, checkpoint.id + ".json");
    const temporary = target + ".tmp";
    await fs.writeFile(temporary, JSON.stringify(checkpoint), "utf8");
    await fs.rename(temporary, target);
  }

  async load(id: string): Promise<Checkpoint | undefined> {
    try {
      return JSON.parse(
        await fs.readFile(path.join(this.directory, id + ".json"), "utf8"),
      ) as Checkpoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

export class DurableCheckpointManager implements CheckpointManager {
  private readonly memory = new Map<string, Checkpoint>();
  private readonly local: RuntimeCheckpointManager;
  private readonly store: CheckpointStore;

  constructor(runtime: WorkspaceRuntime, namespace: string, root?: string) {
    this.local = new RuntimeCheckpointManager(runtime);
    this.store = new FileCheckpointStore(namespace, root);
  }

  async create(signal: AbortSignal): Promise<Checkpoint> {
    const checkpoint = await this.local.create(signal);
    this.memory.set(checkpoint.id, checkpoint);
    await this.store.save(checkpoint);
    return checkpoint;
  }

  async rollback(checkpointId: string, signal: AbortSignal): Promise<{ restoredFiles: string[] }> {
    if (!this.memory.has(checkpointId)) {
      const checkpoint = await this.store.load(checkpointId);
      if (!checkpoint) throw new Error("Unknown checkpoint");
      this.memory.set(checkpointId, checkpoint);
      this.local.remember(checkpoint);
    }

    return this.local.rollback(checkpointId, signal);
  }
}
