import { createHash, randomUUID } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import type { FailureCategory, Strategy } from "./types.js";
import type { LearnedSkillCandidate, SkillLedger } from "./learning.js";
import { containsPromptInjection, redactSecrets } from "../security/guard.js";
import { sofiaStateDirectory } from "../platform/state-directory.js";
import { rankMemoryDocuments } from "./memory-retrieval.js";

export interface ProjectMemoryVerificationProvenance {
  candidateId: string;
  runId: string;
  verifiedAt: string;
  evidenceIds: string[];
  checks: Array<{ name: string; passed: true }>;
}

export interface ProjectMemoryEntry {
  id: string; project: string; kind: "convention" | "repair" | "decision" | "episode" | "feedback"; content: string;
  source?: string; confidence: number; createdAt: string; updatedAt: string; uses: number;
  /** Present only when the record passed an explicit verification gate. */
  verification?: ProjectMemoryVerificationProvenance;
}
export interface ProjectMemoryStore {
  save(entry: ProjectMemoryEntry): Promise<void>;
  list(): Promise<ProjectMemoryEntry[]>;
  find(query: string): Promise<ProjectMemoryEntry[]>;
}

export class FileProjectMemoryStore implements ProjectMemoryStore {
  private readonly file: string;
  constructor(project: string, root = sofiaStateDirectory("memory")) {
    const key = createHash("sha256").update(project).digest("hex"); this.file = path.join(root, key + ".json");
  }
  private async read(): Promise<ProjectMemoryEntry[]> {
    try { return JSON.parse(await fs.readFile(this.file, "utf8")) as ProjectMemoryEntry[]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async save(entry: ProjectMemoryEntry): Promise<void> {
    if (containsPromptInjection(entry.content)) throw new Error("Memory entry rejected by prompt-injection guard.");
    const safeEntry = { ...entry, content: String(redactSecrets(entry.content)).slice(0, 4000) };
    const entries=await this.read(); const i=entries.findIndex(x=>x.id===safeEntry.id); if(i>=0) entries[i]=safeEntry; else entries.push(safeEntry);
    const directory = path.dirname(this.file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const temporary = this.file + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(temporary, JSON.stringify(entries, null, 2), { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, this.file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  async list(){return (await this.read()).filter(entry=>!containsPromptInjection(entry.content));}
  async find(query: string) {
    return rankMemoryDocuments(await this.list(), query, {
      limit: 12,
      maxDocuments: 500,
      minScore: 0.12,
    }).map((result) => result.entry);
  }
  readSync(): ProjectMemoryEntry[] {
    try { const entries=JSON.parse(readFileSync(this.file,"utf8")) as ProjectMemoryEntry[]; return entries.filter(entry=>!containsPromptInjection(entry.content)); }
    catch { return []; }
  }
}

export class PersistentSkillLedger implements SkillLedger {
  private cache: LearnedSkillCandidate[];
  constructor(private readonly store: ProjectMemoryStore) {
    const syncStore = store as FileProjectMemoryStore;
    this.cache = typeof syncStore.readSync === "function"
      ? syncStore.readSync().filter(e=>e.kind==="repair"&&e.project==="skill").map(e=>{try{return JSON.parse(e.content) as LearnedSkillCandidate}catch{return undefined}})
        .filter((e):e is LearnedSkillCandidate=>Boolean(e))
      : [];
  }
  record(candidate: LearnedSkillCandidate): void {
    if (!this.cache.some(x=>x.name===candidate.name&&x.category===candidate.category&&x.trigger===candidate.trigger)) this.cache.push(candidate);
    const now=new Date().toISOString();
    const id=createHash("sha256").update(JSON.stringify({category:candidate.category,strategy:candidate.strategy,trigger:candidate.trigger,procedure:candidate.procedure})).digest("hex");
    void this.store.save({id,project:"skill",kind:"repair",content:JSON.stringify(candidate),source:candidate.evidenceIds.join(","),confidence:0.8,createdAt:now,updatedAt:now,uses:0});
  }
  list(): readonly LearnedSkillCandidate[] { return [...this.cache]; }
}

export function memoryEntryFromConvention(project:string,content:string,source="project-context"):ProjectMemoryEntry{
  const now=new Date().toISOString(); return {id:createHash("sha256").update(project+"\n"+content).digest("hex"),project,kind:"convention",content:content.slice(0,4000),source,confidence:0.9,createdAt:now,updatedAt:now,uses:0};
}
export function memoryEntryFromRepair(project:string,category:FailureCategory,strategy:Strategy,message:string):ProjectMemoryEntry{
  const now=new Date().toISOString(); return {id:createHash("sha256").update(project+category+strategy+message).digest("hex"),project,kind:"repair",content:`Failure: ${category}\nStrategy: ${strategy}\nResolution: ${message.slice(0,1200)}`,source:"brain-recovery",confidence:0.75,createdAt:now,updatedAt:now,uses:0};
}

/** A compact, project-scoped record of one completed or failed agent run. */
export interface EpisodicMemoryEvent {
  /** Stable run identifier; also provides idempotency for repeated writes. */
  runId: string;
  outcome: "completed" | "failed";
  taskSummary: string;
  resultSummary: string;
  occurredAt?: string;
  evidenceIds?: string[];
  tags?: string[];
}

export interface EpisodicMemoryStore {
  record(project: string, event: EpisodicMemoryEvent): Promise<void>;
  find(project: string, query: string, limit?: number): Promise<EpisodicMemoryEvent[]>;
}

/**
 * Reuses the existing project-memory store as the canonical persistence layer.
 * Recording is explicit/opt-in: callers decide which runs are appropriate to retain.
 */
export class ProjectEpisodicMemoryStore implements EpisodicMemoryStore {
  constructor(private readonly store: ProjectMemoryStore) {}

  async record(project: string, event: EpisodicMemoryEvent): Promise<void> {
    const entry = memoryEntryFromEpisode(project, event);
    await this.store.save(entry);
  }

  async find(project: string, query: string, limit = 5): Promise<EpisodicMemoryEvent[]> {
    const matches = await this.store.find(query);
    const bounded = matches
      .filter((entry) => entry.project === project && entry.kind === "episode")
      .slice(0, Math.max(1, Math.min(20, Math.floor(limit))));
    const events: EpisodicMemoryEvent[] = [];
    for (const entry of bounded) {
      try {
        const value: unknown = JSON.parse(entry.content);
        if (isEpisodicMemoryEvent(value)) events.push(value);
      } catch {
        // Ignore malformed legacy or manually edited episode projections.
      }
    }
    return events;
  }
}

function isEpisodicMemoryEvent(value: unknown): value is EpisodicMemoryEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<EpisodicMemoryEvent>;
  return typeof event.runId === "string" && event.runId.length > 0 &&
    (event.outcome === "completed" || event.outcome === "failed") &&
    typeof event.taskSummary === "string" && typeof event.resultSummary === "string";
}

export function memoryEntryFromEpisode(project: string, event: EpisodicMemoryEvent): ProjectMemoryEntry {
  if (!project.trim() || !event.runId.trim()) throw new Error("Project and run identity are required for episodic memory.");
  if (!isEpisodicMemoryEvent(event)) throw new Error("Invalid episodic memory event.");
  const now = new Date().toISOString();
  const occurredAt = event.occurredAt && Number.isFinite(Date.parse(event.occurredAt))
    ? new Date(event.occurredAt).toISOString()
    : now;
  const safeEvent: EpisodicMemoryEvent = {
    runId: event.runId.slice(0, 200),
    outcome: event.outcome,
    taskSummary: event.taskSummary.trim().slice(0, 500),
    resultSummary: event.resultSummary.trim().slice(0, 1_000),
    occurredAt,
    evidenceIds: (event.evidenceIds ?? []).filter((id) => typeof id === "string").slice(0, 20).map((id) => id.slice(0, 200)),
    tags: (event.tags ?? []).filter((tag) => typeof tag === "string").slice(0, 12).map((tag) => tag.slice(0, 64)),
  };
  if (!safeEvent.taskSummary || !safeEvent.resultSummary) throw new Error("Episodic memory summaries cannot be empty.");
  const id = createHash("sha256").update(project + "\u0000episode\u0000" + safeEvent.runId).digest("hex");
  return {
    id,
    project,
    kind: "episode",
    content: JSON.stringify(safeEvent),
    source: "episodic-memory",
    confidence: 1,
    createdAt: occurredAt,
    updatedAt: now,
    uses: 0,
  };
}



/** Explicit feedback about whether a stored memory helped a particular run. */
export interface MemoryFeedbackEvent {
  memoryId: string;
  sourceRunId: string;
  signal: "helpful" | "not_helpful" | "incorrect" | "outdated";
  note?: string;
  occurredAt?: string;
}

export interface MemoryFeedbackSummary {
  project: string;
  memoryId: string;
  total: number;
  helpful: number;
  notHelpful: number;
  incorrect: number;
  outdated: number;
  /** Bounded aggregate in [-1, 1]; a signal for review, not an automatic confidence update. */
  utilityScore: number;
}

export interface MemoryFeedbackStore {
  record(project: string, event: MemoryFeedbackEvent): Promise<void>;
  summarize(project: string, memoryId: string): Promise<MemoryFeedbackSummary>;
}

function isMemoryFeedbackEvent(value: unknown): value is MemoryFeedbackEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<MemoryFeedbackEvent>;
  return typeof event.memoryId === "string" && event.memoryId.length > 0 &&
    typeof event.sourceRunId === "string" && event.sourceRunId.length > 0 &&
    (event.signal === "helpful" || event.signal === "not_helpful" ||
      event.signal === "incorrect" || event.signal === "outdated");
}

/**
 * Feedback is stored alongside project memory, not in a second database.
 * Each (project, memory, source run) tuple is idempotent. Summaries are
 * derived on read and never silently rewrite the source memory's confidence.
 */
export class ProjectMemoryFeedbackStore implements MemoryFeedbackStore {
  constructor(private readonly store: ProjectMemoryStore) {}

  async record(project: string, event: MemoryFeedbackEvent): Promise<void> {
    if (!project.trim() || !isMemoryFeedbackEvent(event) || !event.memoryId.trim() || !event.sourceRunId.trim()) {
      throw new Error("Project, memory identity, source run, and feedback signal are required.");
    }
    const now = new Date().toISOString();
    const occurredAt = event.occurredAt && Number.isFinite(Date.parse(event.occurredAt))
      ? new Date(event.occurredAt).toISOString()
      : now;
    const safeEvent: MemoryFeedbackEvent = {
      memoryId: event.memoryId.slice(0, 200),
      sourceRunId: event.sourceRunId.slice(0, 200),
      signal: event.signal,
      ...(typeof event.note === "string" && event.note.trim()
        ? { note: event.note.trim().slice(0, 500) }
        : {}),
      occurredAt,
    };
    const id = createHash("sha256")
      .update(project + "\u0000feedback\u0000" + safeEvent.memoryId + "\u0000" + safeEvent.sourceRunId)
      .digest("hex");
    await this.store.save({
      id,
      project,
      kind: "feedback",
      content: JSON.stringify(safeEvent),
      source: "memory-feedback",
      confidence: 1,
      createdAt: occurredAt,
      updatedAt: now,
      uses: 0,
    });
  }

  async summarize(project: string, memoryId: string): Promise<MemoryFeedbackSummary> {
    const entries = await this.store.list();
    const events: MemoryFeedbackEvent[] = [];
    for (const entry of entries) {
      if (entry.project !== project || entry.kind !== "feedback") continue;
      try {
        const value: unknown = JSON.parse(entry.content);
        if (isMemoryFeedbackEvent(value) && value.memoryId === memoryId) events.push(value);
      } catch {
        // Ignore malformed feedback records; never reinterpret arbitrary text.
      }
    }
    const summary: MemoryFeedbackSummary = {
      project,
      memoryId,
      total: events.length,
      helpful: events.filter((event) => event.signal === "helpful").length,
      notHelpful: events.filter((event) => event.signal === "not_helpful").length,
      incorrect: events.filter((event) => event.signal === "incorrect").length,
      outdated: events.filter((event) => event.signal === "outdated").length,
      utilityScore: 0,
    };
    if (summary.total > 0) {
      summary.utilityScore = Number(Math.max(-1, Math.min(1,
        (summary.helpful - summary.notHelpful - summary.incorrect * 2 - summary.outdated) / summary.total,
      )).toFixed(3));
    }
    return summary;
  }
}

