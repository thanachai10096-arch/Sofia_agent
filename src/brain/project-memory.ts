import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FailureCategory, Strategy } from "./types.js";
import type { LearnedSkillCandidate, SkillLedger } from "./learning.js";
import { containsPromptInjection, redactSecrets } from "../security/guard.js";

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
  constructor(project: string, root = path.join(os.tmpdir(), "sofia-agents-memory")) {
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
    await fs.mkdir(path.dirname(this.file),{recursive:true}); const tmp=this.file+".tmp";
    await fs.writeFile(tmp,JSON.stringify(entries,null,2),"utf8"); await fs.rename(tmp,this.file);
  }
  async list(){return (await this.read()).filter(entry=>!containsPromptInjection(entry.content));}
  async find(query:string){
    const terms=query.toLowerCase().split(/\s+/).filter(Boolean);
    return (await this.list()).map(entry=>({entry,score:terms.reduce((s,t)=>s+(entry.content.toLowerCase().includes(t)?2:0)+(entry.kind.includes(t)?1:0),0)}))
      .filter(x=>x.score>0).sort((a,b)=>b.score-a.score||b.entry.updatedAt.localeCompare(a.entry.updatedAt)).map(x=>x.entry).slice(0,12);
  }
  readSync(): ProjectMemoryEntry[] {
    try { return JSON.parse(readFileSync(this.file,"utf8")) as ProjectMemoryEntry[]; }
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
