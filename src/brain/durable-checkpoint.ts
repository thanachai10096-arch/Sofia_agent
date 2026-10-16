import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { WorkspaceRuntime } from "../platform/runtime.js";
import type { Checkpoint, CheckpointManager } from "./checkpoint.js";
import { RuntimeCheckpointManager } from "./checkpoint.js";
import { sofiaStateDirectory } from "../platform/state-directory.js";

interface CheckpointStore {
  save(checkpoint: Checkpoint): Promise<void>;
  load(id: string): Promise<Checkpoint | undefined>;
}

class FileCheckpointStore implements CheckpointStore {
  private readonly directory: string;

  constructor(namespace: string, root = sofiaStateDirectory("checkpoints")) {
    const key = createHash("sha256").update(namespace).digest("hex");
    this.directory = path.join(root, key);
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    if (!/^[a-f0-9-]{36}$/i.test(checkpoint.id)) throw new Error("Invalid checkpoint id");
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const target = path.join(this.directory, checkpoint.id + ".json");
    const temporary = target + ".tmp";
    try {
      await fs.writeFile(temporary, JSON.stringify(checkpoint), { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async load(id: string): Promise<Checkpoint | undefined> {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Invalid checkpoint id");
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
