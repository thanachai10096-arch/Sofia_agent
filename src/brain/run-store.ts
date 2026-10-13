import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrainRunSnapshot } from "./run-state.js";

export interface RunStore {
  save(snapshot: BrainRunSnapshot): Promise<void>;
  load(runId: string): Promise<BrainRunSnapshot | undefined>;
  delete(runId: string): Promise<void>;
}

// Serialize replacement of the same snapshot target across store instances. Windows does not
// reliably allow concurrent rename-over-existing-target operations (EPERM).
const saveQueues = new Map<string, Promise<void>>();

function key(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class FileRunStore implements RunStore {
  private readonly directory: string;

  constructor(namespace: string, root = path.join(os.tmpdir(), "sofia-agents-runs")) {
    this.directory = path.join(root, key(namespace));
  }

  private file(runId: string): string {
    return path.join(this.directory, key(runId) + ".json");
  }

  async save(snapshot: BrainRunSnapshot): Promise<void> {
    const target = this.file(snapshot.runId);
    const previous = saveQueues.get(target) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      // Existing store directories may have been created with permissive defaults.
      await fs.chmod(this.directory, 0o700);
      // Each write gets a unique temporary path, and replacement is serialized per target.
      const temporary = target + "." + randomUUID() + ".tmp";
      try {
        await fs.writeFile(temporary, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    });
    saveQueues.set(target, operation);
    try {
      await operation;
    } finally {
      if (saveQueues.get(target) === operation) saveQueues.delete(target);
    }
  }

  async load(runId: string): Promise<BrainRunSnapshot | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.file(runId), "utf8")) as BrainRunSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async delete(runId: string): Promise<void> {
    try {
      await fs.unlink(this.file(runId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
