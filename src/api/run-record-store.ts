import { mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentRunStatus } from "./types.js";
import type { AgentResult } from "../agent/types.js";
export interface RunRecord { id:string; status:AgentRunStatus; result?:AgentResult; error?:string; createdAt:number; updatedAt:number; ownerKeyId:string; desktopCapabilities:string[]; }
export interface RunRecordStore { save(record:RunRecord):Promise<void>; remove(id:string):Promise<void>; loadAllSync():RunRecord[]; }
const SAFE_ID=/^[A-Za-z0-9-]{8,64}$/;
/** Atomic best-effort JSON persistence for one API server instance. */
export class FileRunRecordStore implements RunRecordStore {
 private chain:Promise<void>=Promise.resolve();
 constructor(private readonly directory:string){mkdirSync(directory,{recursive:true,mode:0o700});}
 private file(id:string){if(!SAFE_ID.test(id))throw new Error("Unsafe run id.");return path.join(this.directory,id+".json");}
 save(record:RunRecord):Promise<void>{
  this.chain=this.chain.then(async()=>{try{const target=this.file(record.id),tmp=target+"."+process.pid+".tmp";await fs.writeFile(tmp,JSON.stringify(record),{encoding:"utf8",mode:0o600});await fs.rename(tmp,target);}catch{/* best effort; in-memory state remains authoritative */}});
  return this.chain;
 }
 remove(id:string):Promise<void>{this.chain=this.chain.then(async()=>{try{await fs.unlink(this.file(id));}catch{/* already absent */}});return this.chain;}
 loadAllSync():RunRecord[]{
  const out:RunRecord[]=[];let names:string[];try{names=readdirSync(this.directory);}catch{return out;}
  for(const name of names){const full=path.join(this.directory,name);if(!name.endsWith(".json")){if(name.endsWith(".tmp"))try{unlinkSync(full);}catch{};continue;}
   try{const r=JSON.parse(readFileSync(full,"utf8")) as Partial<RunRecord>;
    if(typeof r.id==="string"&&SAFE_ID.test(r.id)&&name===r.id+".json"&&typeof r.ownerKeyId==="string"&&typeof r.status==="string"&&Number.isFinite(r.createdAt)&&Number.isFinite(r.updatedAt)&&Array.isArray(r.desktopCapabilities)&&r.desktopCapabilities.every(x=>typeof x==="string"))out.push(r as RunRecord);
   }catch{/* ignore corrupt record */}
  }return out;
 }
}
