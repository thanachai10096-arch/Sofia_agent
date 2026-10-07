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
 submit(input:Omit<BrainRunInput,"signal"|"resume">):Promise<JobRecord>;
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
 async save(record:JobRecord):Promise<void>{
  const records=await this.read(); const i=records.findIndex(x=>x.id===record.id);
  const durable={...record};
  if(i>=0)records[i]=durable;else records.push(durable);
  await fs.mkdir(path.dirname(this.file),{recursive:true});
  const tmp=this.file+".tmp"; await fs.writeFile(tmp,JSON.stringify(records,null,2),"utf8"); await fs.rename(tmp,this.file);
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
  const existing=this.jobs.get(id);if(existing)return{...existing};
  const stored=await this.state.get(id);if(!stored)return undefined;
  const snapshot=stored.snapshot?.runId&&this.runStore?await this.runStore.load(stored.snapshot.runId):undefined;
  const hydrated={...stored,...(snapshot?{snapshot}: {})};
  this.jobs.set(id,hydrated);return{...hydrated};
 }

 async list():Promise<JobRecord[]>{
  const stored=await this.state.list();
  for(const record of stored)this.jobs.set(record.id,record);
  return[...this.jobs.values()].map(x=>({...x}));
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
  record.status="running";record.updatedAt=new Date().toISOString();await this.state.save(record);
  const controller=new AbortController();this.controllers.set(record.id,controller);
  if(externalSignal){
   if(externalSignal.aborted)controller.abort(externalSignal.reason);
   else externalSignal.addEventListener("abort",()=>controller.abort(externalSignal.reason),{once:true});
  }
  const onSnapshot=async(snapshot:BrainRunSnapshot)=>{
   record.snapshot=snapshot;record.updatedAt=new Date().toISOString();await this.runStore?.save(snapshot);await this.state.save(record);
  };
  try{
   const brain=this.brainFactory({signal:controller.signal,onRunSnapshot:onSnapshot});
   const result=await brain.run({...input,signal:controller.signal,resume});
   record.result=result;record.status=result.completed?"completed":result.state==="cancelled"?"cancelled":"failed";record.updatedAt=new Date().toISOString();await this.state.save(record);
  }catch(error){
   record.error=error instanceof Error?error.message:String(error);record.status=controller.signal.aborted?"cancelled":"failed";record.updatedAt=new Date().toISOString();await this.state.save(record);
  }finally{this.controllers.delete(record.id);}
 }
}
