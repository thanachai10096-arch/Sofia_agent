import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FailureCategory, Strategy } from "./types.js";
import { lifecycleForSkill } from "./learning.js";
import type { FailureMemory, LearnedSkillCandidate, SkillLedger, SkillOutcome } from "./learning.js";

export interface ProjectMemoryEntry {
  id: string;
  project: string;
  kind: "convention" | "repair" | "decision" | "skill" | "failure";
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

  async record(candidate: LearnedSkillCandidate): Promise<void> {
    const now = new Date().toISOString();
    const id = createHash("sha256")
      .update(JSON.stringify({
        name: candidate.name,
        category: candidate.category,
        strategy: candidate.strategy,
        trigger: candidate.trigger.toLowerCase().slice(0, 600),
      }))
      .digest("hex");
    const entries = await this.store.list();
    const previous = entries.find((entry) => entry.id === id);
    const previousSkill = previous ? parseSkill(previous.content) : undefined;
    const merged = mergeSkill(previousSkill, candidate);
    await this.store.save({
      id,
      project: "skill",
      kind: "skill",
      content: JSON.stringify(merged),
      source: merged.source ?? "agent",
      confidence: merged.confidence ?? 0.55,
      createdAt: merged.createdAt ?? now,
      updatedAt: now,
      uses: merged.attempts ?? 0,
    });
  }

  async list(): Promise<readonly LearnedSkillCandidate[]> {
    const entries = await this.store.list();
    return entries
      .filter((entry) => entry.project === "skill" && (entry.kind === "skill" || entry.kind === "repair"))
      .map((entry) => parseSkill(entry.content))
      .filter((entry): entry is LearnedSkillCandidate => Boolean(entry));
  }

  async recordOutcome(outcome: SkillOutcome): Promise<void> {
    const skills = await this.list();
    const skill = skills.find((item) => item.name === outcome.skillName);
    if (!skill) return;
    const attempts = (skill.attempts ?? 0) + 1;
    const successes = (skill.successes ?? 0) + (outcome.success ? 1 : 0);
    const failures = (skill.failures ?? 0) + (outcome.success ? 0 : 1);
    const empirical = successes / attempts;
    const confidence = Math.max(0, Math.min(1, ((skill.confidence ?? 0.55) * 2 + empirical * attempts) / (attempts + 2)));
    await this.record({
      ...skill,
      confidence,
      attempts,
      successes,
      failures,
      lastUsedAt: new Date().toISOString(),
      ...(outcome.success ? { lastSucceededAt: new Date().toISOString() } : {}),
      evidenceIds: [...new Set([...(skill.evidenceIds ?? []), ...(outcome.evidenceIds ?? [])])].slice(-40),
      lifecycle: lifecycleForSkill({ ...skill, confidence, attempts, successes, failures, lastUsedAt: new Date().toISOString(), ...(outcome.success ? { lastSucceededAt: new Date().toISOString() } : { lastFailedAt: new Date().toISOString() }) }),
    });
  }

  async recordFailure(failure: FailureMemory): Promise<void> {
    const existing = (await this.store.list()).find((entry) => entry.project === "failure" && entry.id === failure.id);
    const merged = existing ? parseFailure(existing.content) : undefined;
    const now = new Date().toISOString();
    await this.store.save({
      id: failure.id,
      project: "failure",
      kind: "failure",
      content: JSON.stringify({
        ...failure,
        attempts: Math.max(merged?.attempts ?? 0, failure.attempts),
        resolved: Boolean(merged?.resolved || failure.resolved),
        updatedAt: now,
      }),
      source: "brain-recovery",
      confidence: failure.resolved ? 0.9 : 0.5,
      createdAt: merged?.createdAt ?? failure.createdAt,
      updatedAt: now,
      uses: failure.attempts,
    });
  }

  async listFailures(query?: string): Promise<readonly FailureMemory[]> {
    const entries = await this.store.list();
    const failures = entries
      .filter((entry) => entry.project === "failure" && entry.kind === "failure")
      .map((entry) => parseFailure(entry.content))
      .filter((entry): entry is FailureMemory => Boolean(entry));
    if (!query) return failures.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20);
    const terms = query.toLowerCase().split(/[^a-z0-9_:-]+/i).filter((term) => term.length >= 3);
    return failures
      .map((failure) => ({ failure, score: (failure.resolved ? 5 : 0) + terms.filter((term) => failure.message.toLowerCase().includes(term)).length * 4 }))
      .sort((a, b) => b.score - a.score || b.failure.updatedAt.localeCompare(a.failure.updatedAt))
      .map((item) => item.failure)
      .slice(0, 20);
  }

  async rank(category: import("./types.js").FailureCategory, message: string, limit = 5) {
    const { rankLearnedSkills } = await import("./learning.js");
    return rankLearnedSkills(await this.list(), category, message, limit);
  }
}

function parseSkill(value: string): LearnedSkillCandidate | undefined {
  try { return JSON.parse(value) as LearnedSkillCandidate; } catch { return undefined; }
}

function parseFailure(value: string): FailureMemory | undefined {
  try { return JSON.parse(value) as FailureMemory; } catch { return undefined; }
}

function mergeSkill(previous: LearnedSkillCandidate | undefined, candidate: LearnedSkillCandidate): LearnedSkillCandidate {
  const now = new Date().toISOString();
  if (!previous) return { ...candidate, confidence: candidate.confidence ?? 0.55, attempts: candidate.attempts ?? 0, successes: candidate.successes ?? 0, failures: candidate.failures ?? 0, createdAt: candidate.createdAt ?? now, updatedAt: now };
  return { ...previous, ...candidate, confidence: candidate.confidence ?? previous.confidence ?? 0.55, attempts: Math.max(previous.attempts ?? 0, candidate.attempts ?? 0), successes: Math.max(previous.successes ?? 0, candidate.successes ?? 0), failures: Math.max(previous.failures ?? 0, candidate.failures ?? 0), createdAt: previous.createdAt ?? candidate.createdAt ?? now, updatedAt: now };
}

