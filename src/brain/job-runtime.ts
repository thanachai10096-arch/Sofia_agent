import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrainRunInput, SofiaBrain } from "./executor.js";
import type { BrainRunSnapshot } from "./run-state.js";
import type { RunStore } from "./run-store.js";

export type JobStatus="queued"|"running"|"completed"|"failed"|"cancelled";
export interface JobRecord{id:string;status:JobStatus;createdAt:string;updatedAt:string;task:string;ownerKeyId?:string;snapshot?:BrainRunSnapshot;result?:Awaited<ReturnType<SofiaBrain["run"]>>;error?:string;}
export interface JobRuntime{
 submit(input:Omit<BrainRunInput,"signal"|"resume"> & { ownerKeyId?: string }):Promise<JobRecord>;
 get(id:string):Promise<JobRecord|undefined>;
 resume(id:string,signal?:AbortSignal):Promise<JobRecord>;
 cancel(id:string):Promise<boolean>;
 list():Promise<JobRecord[]>;
}

class FileJobStateStore {
 private readonly file:string;
 constructor(namespace:string,root=path.join(os.tmpdir(),"sofia-agents-jobs")){
  this.file=path.join(root,createHash("sha256").update(namespace).digest("hex")+".json");
 }
 private async read():Promise<JobRecord[]>{
  try{return JSON.parse(await fs.readFile(this.file,"utf8")) as JobRecord[];}
  catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return[];throw error;}
 }
 private writeQueue:Promise<void>=Promise.resolve();
 async save(record:JobRecord):Promise<void>{
  const operation=this.writeQueue.then(async()=>{
   const records=await this.read(); const i=records.findIndex(x=>x.id===record.id);
   const durable={...record};
   if(i>=0)records[i]=durable;else records.push(durable);
   await fs.mkdir(path.dirname(this.file),{recursive:true});
   const tmp=this.file+"."+randomUUID()+".tmp";
   try{
    await fs.writeFile(tmp,JSON.stringify(records,null,2),"utf8");
    await fs.rename(tmp,this.file);
   }finally{
    await fs.rm(tmp,{force:true}).catch(()=>undefined);
   }
  });
  this.writeQueue=operation.catch(()=>undefined);
  await operation;
 }
 async list():Promise<JobRecord[]>{return this.read();}
 async get(id:string){return(await this.read()).find(x=>x.id===id);}
}

export class DurableJobRuntime implements JobRuntime{
 private readonly jobs=new Map<string,JobRecord>();
 private readonly controllers=new Map<string,AbortController>();
 private readonly resuming=new Set<string>();
 private readonly state:FileJobStateStore;

 constructor(
  private readonly brainFactory:(options:{signal?:AbortSignal;maxSteps?:number;onRunSnapshot?: (snapshot: BrainRunSnapshot) => void | Promise<void>})=>SofiaBrain,
  private readonly runStore?:RunStore,
  namespace=process.cwd(),
 ){this.state=new FileJobStateStore(namespace);}

 async submit(input:Omit<BrainRunInput,"signal"|"resume"> & { ownerKeyId?: string }):Promise<JobRecord>{
  const id=randomUUID(),now=new Date().toISOString();
  const record:JobRecord={id,status:"queued",createdAt:now,updatedAt:now,task:input.task,...(input.ownerKeyId?{ownerKeyId:input.ownerKeyId}:{})};
  this.jobs.set(id,record);await this.state.save(record);void this.execute(record,input);return{...record};
 }

 async get(id:string):Promise<JobRecord|undefined>{
  const existing=this.jobs.get(id);
  if(existing)return{...existing};
  const stored=await this.state.get(id);if(!stored)return undefined;
  return this.hydrateStoredRecord(stored);
 }

 async list():Promise<JobRecord[]>{
  const stored=await this.state.list();
  const records:JobRecord[]=[];
  for(const item of stored){
   const active=this.jobs.get(item.id);
   if(active){
    records.push({...active});
    continue;
   }
   records.push(await this.hydrateStoredRecord(item));
  }
  return records;
 }

 private async hydrateStoredRecord(stored:JobRecord):Promise<JobRecord>{
  const snapshot=stored.snapshot?.runId&&this.runStore
   ?await this.runStore.load(stored.snapshot.runId)
   :stored.snapshot;
  const hydrated:JobRecord={...stored,...(snapshot?{snapshot}:{})};
  if(hydrated.status==="running"||hydrated.status==="queued"){
   hydrated.status="failed";
   hydrated.updatedAt=new Date().toISOString();
   hydrated.error=hydrated.snapshot
    ?"Worker stopped before completion; resume this job from its saved checkpoint."
    :"Worker stopped before a resumable checkpoint was saved.";
   await this.state.save(hydrated);
  }
  this.jobs.set(hydrated.id,hydrated);
  return{...hydrated};
 }

 async resume(id:string,signal?:AbortSignal):Promise<JobRecord>{
  if(this.resuming.has(id))throw new Error("Job is already being resumed");
  const record=await this.get(id);if(!record)throw new Error("Unknown job");
  if(record.status==="completed")return record;
  if(!record.snapshot)throw new Error("Job has no resumable snapshot");
  this.resuming.add(id);
  try{
   await this.execute(record,{task:record.task,acceptanceCriteria:record.snapshot.acceptanceCriteria},signal,record.snapshot);
   return{...record};
  }finally{this.resuming.delete(id);}
 }

 async cancel(id:string):Promise<boolean>{
  const controller=this.controllers.get(id);
  if(!controller){
   const record=await this.get(id);if(!record)return false;
   if(record.status==="completed"||record.status==="failed"||record.status==="cancelled")return false;
   record.status="cancelled";record.updatedAt=new Date().toISOString();await this.state.save(record);return true;
  }
  controller.abort(new Error("Job cancelled by caller"));return true;
 }

 private async execute(record:JobRecord,input:Omit<BrainRunInput,"signal"|"resume">,externalSignal?:AbortSignal,resume?:BrainRunSnapshot){
  if(record.status==="running"||record.status==="cancelled")return;
  record.status="running";record.updatedAt=new Date().toISOString();
  const controller=new AbortController();this.controllers.set(record.id,controller);
  if(externalSignal){
   if(externalSignal.aborted)controller.abort(externalSignal.reason);
   else externalSignal.addEventListener("abort",()=>controller.abort(externalSignal.reason),{once:true});
  }
  const onSnapshot=async(snapshot:BrainRunSnapshot)=>{
   record.snapshot=snapshot;record.updatedAt=new Date().toISOString();await this.runStore?.save(snapshot);await this.state.save(record);
  };
  try{
   await this.state.save(record);
   const brain=this.brainFactory({signal:controller.signal,onRunSnapshot:onSnapshot});
   const result=await brain.run({...input,...(record.ownerKeyId?{principalId:record.ownerKeyId}:{}),signal:controller.signal,resume});
   record.result=result;record.status=result.completed?"completed":result.state==="cancelled"?"cancelled":"failed";record.updatedAt=new Date().toISOString();await this.state.save(record);
  }catch(error){
   record.error=error instanceof Error?error.message:String(error);record.status=controller.signal.aborted?"cancelled":"failed";record.updatedAt=new Date().toISOString();
   try{await this.state.save(record);}catch{/* Keep the terminal error in memory if durable storage is unavailable. */}
  }finally{this.controllers.delete(record.id);}
 }
}
