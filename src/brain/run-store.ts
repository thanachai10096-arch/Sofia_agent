import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrainRunSnapshot } from "./run-state.js";

export interface RunStore {
  save(snapshot: BrainRunSnapshot): Promise<void>;
  load(runId: string): Promise<BrainRunSnapshot | undefined>;
  delete(runId: string): Promise<void>;
}

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
    await fs.mkdir(this.directory, { recursive: true });
    const target = this.file(snapshot.runId);
    const temporary = target + ".tmp";
    await fs.writeFile(temporary, JSON.stringify(snapshot), "utf8");
    await fs.rename(temporary, target);
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
