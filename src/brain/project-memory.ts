import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FailureCategory, Strategy } from "./types.js";
import type { LearnedSkillCandidate, SkillLedger } from "./learning.js";

export interface ProjectMemoryEntry {
  id: string;
  project: string;
  kind: "convention" | "repair" | "decision";
  content: string;
  source?: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  uses: number;
}

export interface ProjectMemoryStore {
  save(entry: ProjectMemoryEntry): Promise<void>;
  list(): Promise<ProjectMemoryEntry[]>;
  find(query: string): Promise<ProjectMemoryEntry[]>;
}

export class FileProjectMemoryStore implements ProjectMemoryStore {
  private readonly file: string;

  constructor(
    project: string,
    root = path.join(os.tmpdir(), "sofia-agents-memory"),
  ) {
    const key = createHash("sha256").update(project).digest("hex");
    this.file = path.join(root, key + ".json");
  }

  private async read(): Promise<ProjectMemoryEntry[]> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as ProjectMemoryEntry[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async save(entry: ProjectMemoryEntry): Promise<void> {
    const entries = await this.read();
    const index = entries.findIndex((item) => item.id === entry.id);
    if (index >= 0) entries[index] = entry;
    else entries.push(entry);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = this.file + ".tmp";
    await fs.writeFile(temporary, JSON.stringify(entries, null, 2), "utf8");
    await fs.rename(temporary, this.file);
  }

  async list(): Promise<ProjectMemoryEntry[]> {
    return this.read();
  }

  async find(query: string): Promise<ProjectMemoryEntry[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (await this.read())
      .map((entry) => ({
        entry,
        score: terms.reduce(
          (score, term) =>
            score +
            (entry.content.toLowerCase().includes(term) ? 2 : 0) +
            (entry.kind.includes(term) ? 1 : 0),
          0,
        ),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
      .map((item) => item.entry)
      .slice(0, 12);
  }
}

export class PersistentSkillLedger implements SkillLedger {
  constructor(private readonly store: ProjectMemoryStore) {}

  record(candidate: LearnedSkillCandidate): void {
    const now = new Date().toISOString();
    const id = createHash("sha256")
      .update(JSON.stringify({
        category: candidate.category,
        strategy: candidate.strategy,
        trigger: candidate.trigger,
        procedure: candidate.procedure,
      }))
      .digest("hex");

    void this.store.save({
      id,
      project: "skill",
      kind: "repair",
      content: JSON.stringify(candidate),
      source: candidate.evidenceIds.join(","),
      confidence: 0.8,
      createdAt: now,
      updatedAt: now,
      uses: 0,
    });
  }

  list(): readonly LearnedSkillCandidate[] {
    return [];
  }
}

export function memoryEntryFromConvention(project: string, content: string, source = "project-context"): ProjectMemoryEntry {
  const now = new Date().toISOString();
  const id = createHash("sha256").update(project + "\n" + content).digest("hex");
  return {
    id,
    project,
    kind: "convention",
    content: content.slice(0, 4000),
    source,
    confidence: 0.9,
    createdAt: now,
    updatedAt: now,
    uses: 0,
  };
}

export function memoryEntryFromRepair(
  project: string,
  category: FailureCategory,
  strategy: Strategy,
  message: string,
): ProjectMemoryEntry {
  const now = new Date().toISOString();
  const id = createHash("sha256")
    .update(project + category + strategy + message)
    .digest("hex");
  return {
    id,
    project,
    kind: "repair",
    content: `Failure: ${category}\nStrategy: ${strategy}\nResolution: ${message.slice(0, 1200)}`,
    source: "brain-recovery",
    confidence: 0.75,
    createdAt: now,
    updatedAt: now,
    uses: 0,
  };
}
