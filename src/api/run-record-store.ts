import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, lstatSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentRunStatus } from "./types.js";
import type { AgentResult } from "../agent/types.js";

export interface RunRecord { id:string; status:AgentRunStatus; result?:AgentResult; error?:string; createdAt:number; updatedAt:number; ownerKeyId:string; desktopCapabilities:string[]; /** SHA-256 of owner-scoped idempotency key; never store the raw key. */ idempotencyId?:string; requestFingerprint?:string; }
export interface RunRecordStore { save(record:RunRecord):Promise<void>; remove(id:string):Promise<void>; loadAllSync():RunRecord[]; }
const SAFE_ID=/^[A-Za-z0-9-]{8,64}$/;
const STATUSES=new Set(["queued","running","completed","failed","cancelled"]);
const KINDS=new Set(["coding","debugging","research","analysis","vision","general"]);
const CAPABILITIES=new Set(["system:discover","workspace:list","workspace:read","workspace:write","process:execute","screen:capture","app:launch","input:control"]);
const EVENT_TYPES=new Set(["run.started","task.classified","model.selected","model.completed","tool.started","tool.completed","tool.failed","tool.output_suspicious","tool.approval_required","review.started","review.completed","retry","run.completed","run.failed"]);
// Serialize writes/removals to the same record across store instances in this process.
// This is not a cross-process lock; shared multi-worker storage still needs a transactional backend.
const recordQueues = new Map<string, Promise<void>>();
function enqueueRecordOperation(target: string, operation: () => Promise<void>): Promise<void> {
 const previous = recordQueues.get(target) ?? Promise.resolve();
 const next = previous.catch(() => undefined).then(operation);
 recordQueues.set(target, next);
 void next.finally(() => { if (recordQueues.get(target) === next) recordQueues.delete(target); }).catch(() => undefined);
 return next;
}
function validResult(value:unknown):value is AgentResult {
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const r=value as Partial<AgentResult>;
 if(typeof r.runId!=="string"||!SAFE_ID.test(r.runId)||typeof r.output!=="string"||r.output.length>1_000_000||typeof r.kind!=="string"||!KINDS.has(r.kind)||!Number.isSafeInteger(r.steps)||((r.steps??-1)<0)||!Array.isArray(r.events)||r.events.length>20_000)return false;
 return r.events.every((event)=>!!event&&typeof event==="object"&&!Array.isArray(event)&&typeof event.type==="string"&&EVENT_TYPES.has(event.type)&&typeof event.message==="string"&&event.message.length<=20_000&&(event.step===undefined||Number.isSafeInteger(event.step))&&(event.metadata===undefined||(!!event.metadata&&typeof event.metadata==="object"&&!Array.isArray(event.metadata))));
}
function quarantineInvalidRecord(directory: string, filename: string, fullPath: string, isSymlink = false): void {
 try {
  const quarantineDirectory = path.join(directory, "quarantine");
  mkdirSync(quarantineDirectory, { recursive: true, mode: 0o700 });
  const quarantineStat = lstatSync(quarantineDirectory);
  if (quarantineStat.isSymbolicLink() || !quarantineStat.isDirectory()) return;
  try { chmodSync(quarantineDirectory, 0o700); } catch {}
  const destination = path.join(quarantineDirectory, filename + "." + Date.now() + "." + randomUUID() + ".invalid");
  renameSync(fullPath, destination);
  if (!isSymlink) { try { chmodSync(destination, 0o600); } catch {} }
 } catch {
  // Preserve the original in place when quarantine is unavailable; never delete malformed records.
 }
}
function validRecord(value:unknown,filename:string):value is RunRecord {
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const r=value as Partial<RunRecord>;
 if(typeof r.id!=="string"||!SAFE_ID.test(r.id)||filename!==r.id+".json")return false;
 if(typeof r.status!=="string"||!STATUSES.has(r.status))return false;
 if(!Number.isSafeInteger(r.createdAt)||!Number.isSafeInteger(r.updatedAt)||(r.createdAt as number)<0||(r.updatedAt as number)<(r.createdAt as number))return false;
 if(typeof r.ownerKeyId!=="string"||!/^[a-f0-9]{32}$/.test(r.ownerKeyId))return false;
 if(!Array.isArray(r.desktopCapabilities)||!r.desktopCapabilities.every((x)=>typeof x==="string"&&CAPABILITIES.has(x)))return false;
 if(r.error!==undefined&&(typeof r.error!=="string"||r.error.length>20_000))return false;
 if(r.idempotencyId!==undefined&&(typeof r.idempotencyId!=="string"||!/^[a-f0-9]{64}$/.test(r.idempotencyId)))return false;
 if(r.requestFingerprint!==undefined&&(typeof r.requestFingerprint!=="string"||!/^[a-f0-9]{64}$/.test(r.requestFingerprint)))return false;
 if((r.idempotencyId===undefined)!==(r.requestFingerprint===undefined))return false;
 if(r.result!==undefined&&!validResult(r.result))return false;
 if(r.status==="completed"&&r.result===undefined)return false;
 if(r.status==="failed"&&r.error===undefined)return false;
 return true;
}
/** Atomic best-effort JSON persistence for one API server instance. */
export class FileRunRecordStore implements RunRecordStore {
 constructor(private readonly directory:string){mkdirSync(directory,{recursive:true,mode:0o700});try{chmodSync(directory,0o700);}catch{/* permissions unavailable on this platform */}}
 private file(id:string){if(!SAFE_ID.test(id))throw new Error("Unsafe run id.");return path.join(this.directory,id+".json");}
 save(record:RunRecord):Promise<void>{
  const target=this.file(record.id);
  return enqueueRecordOperation(target,async()=>{
   const tmp=target+"."+process.pid+"."+randomUUID()+".tmp";
   try{
    await fs.writeFile(tmp,JSON.stringify(record),{encoding:"utf8",mode:0o600});
    try{await fs.chmod(tmp,0o600);}catch{}
    await fs.rename(tmp,target);
   }catch{/* best effort; in-memory state remains authoritative */}
   finally{try{await fs.unlink(tmp);}catch{/* renamed or already absent */}}
  });
 }
 remove(id:string):Promise<void>{
  const target=this.file(id);
  return enqueueRecordOperation(target,async()=>{try{await fs.unlink(target);}catch{/* already absent */}});
 }
 loadAllSync():RunRecord[]{
  const out:RunRecord[]=[];let names:string[];try{names=readdirSync(this.directory);}catch{return out;}
  for(const name of names){const full=path.join(this.directory,name);if(!name.endsWith(".json")){if(name.endsWith(".tmp"))try{if(Date.now()-statSync(full).mtimeMs>24*60*60*1000)unlinkSync(full);}catch{};continue;}
   try {
    const fileStat = lstatSync(full);
    if (fileStat.isSymbolicLink()) { quarantineInvalidRecord(this.directory, name, full, true); continue; }
    if (!fileStat.isFile()) { quarantineInvalidRecord(this.directory, name, full); continue; }
    const parsed: unknown = JSON.parse(readFileSync(full, "utf8"));
    if (validRecord(parsed, name)) out.push(parsed);
    else quarantineInvalidRecord(this.directory, name, full);
   } catch { quarantineInvalidRecord(this.directory, name, full); }
  }return out;
 }
}
