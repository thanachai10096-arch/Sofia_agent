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

export class PersistentSkillLedger implements SkillLedger {
  private cache: LearnedSkillCandidate[];
  private persistChain: Promise<void> = Promise.resolve();
  constructor(private readonly store: ProjectMemoryStore) {
    const syncStore = store as FileProjectMemoryStore;
    this.cache = typeof syncStore.readSync === "function"
      ? syncStore.readSync().filter(e=>e.kind==="repair"&&e.project==="skill").map(e=>{try{return JSON.parse(e.content) as LearnedSkillCandidate}catch{return undefined}})
        .filter((e):e is LearnedSkillCandidate=>Boolean(e))
      : [];
  }
  record(candidate: LearnedSkillCandidate): void {
    // A stable identity lets repeated successful work improve an existing skill
    // instead of creating an unbounded collection of near-duplicates.
    const existingIndex = this.cache.findIndex(item => item.name === candidate.name && item.category === candidate.category);
    const previous = existingIndex >= 0 ? this.cache[existingIndex] : undefined;
    const merged: LearnedSkillCandidate = previous ? {
      ...candidate,
      trigger: previous.trigger,
      triggers: [...new Set([previous.trigger, ...(previous.triggers ?? []), candidate.trigger, ...(candidate.triggers ?? [])]
        .map(value => String(redactSecrets(value)).trim()).filter(Boolean))].slice(0, 12),
      procedure: [...new Set(candidate.procedure)].slice(0, 12),
      verification: [...new Set([...previous.verification, ...candidate.verification])].filter(
        (item): item is "typecheck" | "test" | "build" => item === "typecheck" || item === "test" || item === "build",
      ),
      evidenceIds: [...new Set([...previous.evidenceIds, ...candidate.evidenceIds])].slice(-50),
    } : {
      ...candidate,
      trigger: String(redactSecrets(candidate.trigger)).slice(0, 240),
      triggers: [...new Set([candidate.trigger, ...(candidate.triggers ?? [])])].slice(0, 12),
      procedure: [...new Set(candidate.procedure)].slice(0, 12),
      evidenceIds: [...new Set(candidate.evidenceIds)].slice(-50),
    };
    if (existingIndex >= 0) this.cache[existingIndex] = merged;
    else this.cache.push(merged);
    const now = new Date().toISOString();
    const id = createHash("sha256").update(JSON.stringify({ name: merged.name, category: merged.category })).digest("hex");
    this.persistChain = this.persistChain.then(() => this.store.save({
      id, project: "skill", kind: "repair", content: JSON.stringify(merged),
      source: merged.evidenceIds.join(","), confidence: Math.min(0.99, 0.8 + Math.min(merged.evidenceIds.length, 10) * 0.015),
      createdAt: now, updatedAt: now, uses: previous ? 1 : 0,
    })).catch(() => {
      // Learning persistence is best-effort; it must not change task outcome.
    });
  }
  async flush(): Promise<void> { await this.persistChain; }
  list(): readonly LearnedSkillCandidate[] { return [...this.cache]; }
}

export function memoryEntryFromConvention(project:string,content:string,source="project-context"):ProjectMemoryEntry{
  const now=new Date().toISOString(); return {id:createHash("sha256").update(project+"\n"+content).digest("hex"),project,kind:"convention",content:content.slice(0,4000),source,confidence:0.9,createdAt:now,updatedAt:now,uses:0};
}
export function memoryEntryFromRepair(project:string,category:FailureCategory,strategy:Strategy,message:string):ProjectMemoryEntry{
  const now=new Date().toISOString(); return {id:createHash("sha256").update(project+category+strategy+message).digest("hex"),project,kind:"repair",content:`Failure: ${category}\nStrategy: ${strategy}\nResolution: ${message.slice(0,1200)}`,source:"brain-recovery",confidence:0.75,createdAt:now,updatedAt:now,uses:0};
}
