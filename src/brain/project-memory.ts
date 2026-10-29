import { createHash, randomUUID } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import type { FailureCategory, Strategy } from "./types.js";
import type { LearnedSkillCandidate, SkillLedger } from "./learning.js";
import { containsPromptInjection, redactSecrets } from "../security/guard.js";
import { sofiaStateDirectory } from "../platform/state-directory.js";

export interface ProjectMemoryEntry {
  id: string; project: string; kind: "convention" | "repair" | "decision"; content: string;
  source?: string; confidence: number; createdAt: string; updatedAt: string; uses: number;
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
    const terms = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
    if (terms.length === 0) return [];

    const phrase = terms.join(" ");
    return (await this.list())
      .map((entry) => {
        const content = entry.content.toLocaleLowerCase();
        const contentTerms = new Set(content.match(/[\p{L}\p{N}_-]+/gu) ?? []);
        const kindTerms = new Set(entry.kind.toLocaleLowerCase().split(/[-_\s]+/));
        const matched = terms.reduce(
          (count, term) => count + (contentTerms.has(term) ? 1 : 0),
          0,
        );
        const kindMatches = terms.reduce(
          (count, term) => count + (kindTerms.has(term) ? 1 : 0),
          0,
        );
        const confidence = Number.isFinite(entry.confidence)
          ? Math.max(0, Math.min(1, entry.confidence))
          : 0;
        const phraseBonus = phrase.length > 2 && content.includes(phrase) ? 3 : 0;
        return {
          entry,
          score: matched * 2 + kindMatches + phraseBonus + confidence * 0.25,
          matched,
        };
      })
      .filter((item) => item.matched > 0)
      .sort((a, b) =>
        b.score - a.score ||
        b.entry.updatedAt.localeCompare(a.entry.updatedAt),
      )
      .map((item) => item.entry)
      .slice(0, 12);
  }
  readSync(): ProjectMemoryEntry[] {
    try { const entries=JSON.parse(readFileSync(this.file,"utf8")) as ProjectMemoryEntry[]; return entries.filter(entry=>!containsPromptInjection(entry.content)); }
    catch { return []; }
  }
}

const LEARNABLE_CATEGORIES = new Set<FailureCategory>([
  "syntax_error", "type_error", "runtime_error", "dependency_error", "permission_error",
  "network_error", "tool_error", "wrong_assumption", "incomplete_solution", "environment_error", "unknown",
]);
const LEARNABLE_STRATEGIES = new Set<Strategy>([
  "initial", "inspect-evidence", "fix-implementation", "fix-environment", "alternative-tool",
]);

function validateLearnedCandidate(candidate: LearnedSkillCandidate): LearnedSkillCandidate {
  if (!candidate || typeof candidate !== "object" ||
      typeof candidate.name !== "string" || candidate.name.trim().length === 0 || candidate.name.length > 200 ||
      typeof candidate.trigger !== "string" || candidate.trigger.trim().length === 0 || candidate.trigger.length > 240 ||
      !LEARNABLE_CATEGORIES.has(candidate.category) || !LEARNABLE_STRATEGIES.has(candidate.strategy) ||
      !Array.isArray(candidate.procedure) || candidate.procedure.length < 2 || candidate.procedure.length > 100 ||
      !candidate.procedure.every(step => typeof step === "string" && step.trim().length > 0 && step.length <= 2000) ||
      !Array.isArray(candidate.verification) || candidate.verification.length < 1 || candidate.verification.length > 3 ||
      !candidate.verification.every(item => item === "typecheck" || item === "test" || item === "build") ||
      !Array.isArray(candidate.evidenceIds) || candidate.evidenceIds.length < 1 || candidate.evidenceIds.length > 100 ||
      !candidate.evidenceIds.every(id => typeof id === "string" && id.trim().length > 0 && id.length <= 500) ||
      new Set(candidate.evidenceIds).size !== candidate.evidenceIds.length) {
    throw new Error("Invalid learned skill candidate");
  }
  const trigger = String(redactSecrets(candidate.trigger)).slice(0, 240);
  const procedure = candidate.procedure.map(step => String(redactSecrets(step)).slice(0, 2000));
  if (containsPromptInjection(trigger) || procedure.some(step => containsPromptInjection(step))) {
    throw new Error("Learned skill candidate rejected by prompt-injection guard");
  }
  return {
    name: candidate.name.slice(0, 200),
    trigger,
    category: candidate.category,
    strategy: candidate.strategy,
    procedure,
    verification: [...candidate.verification],
    evidenceIds: [...candidate.evidenceIds],
  };
}

export class PersistentSkillLedger implements SkillLedger {
  private cache: LearnedSkillCandidate[];
  private pending: Promise<void> = Promise.resolve();
  private persistenceError: string | null = null;
  private pendingWrites = 0;

  constructor(private readonly store: ProjectMemoryStore) {
    const syncStore = store as FileProjectMemoryStore;
    this.cache = typeof syncStore.readSync === "function"
      ? syncStore.readSync()
          .filter(entry => entry.kind === "repair" && entry.project === "skill")
          .map(entry => {
            try { return validateLearnedCandidate(JSON.parse(entry.content) as LearnedSkillCandidate); }
            catch { return undefined; }
          })
          .filter((entry): entry is LearnedSkillCandidate => Boolean(entry))
      : [];
  }

  record(candidate: LearnedSkillCandidate): void {
    const safe = validateLearnedCandidate(candidate);
    const duplicate = this.cache.some(item =>
      item.name === safe.name && item.category === safe.category &&
      item.trigger === safe.trigger && JSON.stringify(item.procedure) === JSON.stringify(safe.procedure));
    if (duplicate) return;

    this.cache.push(safe);
    const now = new Date().toISOString();
    const id = createHash("sha256").update(JSON.stringify({
      category: safe.category, strategy: safe.strategy, trigger: safe.trigger, procedure: safe.procedure,
    })).digest("hex");
    const entry: ProjectMemoryEntry = {
      id, project: "skill", kind: "repair", content: JSON.stringify(safe),
      source: safe.evidenceIds.join(","), confidence: 0.8, createdAt: now, updatedAt: now, uses: 0,
    };

    // Serialize writes and observe failures instead of creating an unhandled rejection.
    this.pendingWrites += 1;
    this.pending = this.pending.then(() => this.store.save(entry)).then(
      () => undefined,
      error => {
        this.persistenceError = error instanceof Error ? error.message : String(error);
        // A failed durable write must not leave a phantom skill available to later matching.
        this.cache = this.cache.filter(item => item !== safe);
      },
    ).finally(() => { this.pendingWrites = Math.max(0, this.pendingWrites - 1); });
  }

  list(): readonly LearnedSkillCandidate[] {
    return this.cache.map(candidate => ({
      ...candidate,
      procedure: [...candidate.procedure],
      verification: [...candidate.verification],
      evidenceIds: [...candidate.evidenceIds],
    }));
  }

  async flush(): Promise<void> {
    await this.pending;
    if (this.persistenceError) throw new Error("Skill ledger persistence failed: " + this.persistenceError);
  }

  getPersistenceStatus(): { pending: boolean; lastError: string | null } {
    return { pending: this.pendingWrites > 0, lastError: this.persistenceError };
  }
}

export function memoryEntryFromConvention(project:string,content:string,source="project-context"):ProjectMemoryEntry{
  const now=new Date().toISOString(); return {id:createHash("sha256").update(project+"\n"+content).digest("hex"),project,kind:"convention",content:content.slice(0,4000),source,confidence:0.9,createdAt:now,updatedAt:now,uses:0};
}
export function memoryEntryFromRepair(project:string,category:FailureCategory,strategy:Strategy,message:string):ProjectMemoryEntry{
  const now=new Date().toISOString(); return {id:createHash("sha256").update(project+category+strategy+message).digest("hex"),project,kind:"repair",content:`Failure: ${category}\nStrategy: ${strategy}\nResolution: ${message.slice(0,1200)}`,source:"brain-recovery",confidence:0.75,createdAt:now,updatedAt:now,uses:0};
}
