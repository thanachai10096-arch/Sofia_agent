import { randomUUID } from "node:crypto";
import type { BrainRunInput, SofiaBrain } from "./executor.js";
import type { BrainRunSnapshot } from "./run-state.js";
import type { RunStore } from "./run-store.js";

export type JobStatus = "queued"|"running"|"completed"|"failed"|"cancelled";

export interface JobRecord {
  id:string; status:JobStatus; createdAt:string; updatedAt:string; task:string;
  snapshot?:BrainRunSnapshot; result?:Awaited<ReturnType<SofiaBrain["run"]>>; error?:string;
}
export interface JobRuntime {
  submit(input:Omit<BrainRunInput,"signal"|"resume">):Promise<JobRecord>;
  get(id:string):Promise<JobRecord|undefined>;
  resume(id:string,signal?:AbortSignal):Promise<JobRecord>;
  cancel(id:string):Promise<boolean>;
  list():Promise<JobRecord[]>;
}

export class DurableJobRuntime implements JobRuntime {
  private readonly jobs=new Map<string,JobRecord>();
  private readonly controllers=new Map<string,AbortController>();
  private readonly resuming=new Set<string>();

  constructor(
    private readonly brainFactory:(options:{signal?:AbortSignal;maxSteps?:number})=>SofiaBrain,
    private readonly runStore?:RunStore,
  ) {}

  async submit(input:Omit<BrainRunInput,"signal"|"resume">):Promise<JobRecord>{
    const id=randomUUID(), now=new Date().toISOString();
    const record:JobRecord={id,status:"queued",createdAt:now,updatedAt:now,task:input.task};
    this.jobs.set(id,record); void this.execute(record,input);
    return{...record};
  }

  async get(id:string):Promise<JobRecord|undefined>{
    const existing=this.jobs.get(id); if(existing)return{...existing};
    const snapshot=await this.runStore?.load(id); if(!snapshot)return undefined;
    return{id,status:"queued",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),task:snapshot.task,snapshot};
  }

  async resume(id:string,signal?:AbortSignal):Promise<JobRecord>{
    if(this.resuming.has(id))throw new Error("Job is already being resumed");
    const record=this.jobs.get(id);
    if(!record)throw new Error("Unknown job");
    if(record.status==="completed")return{...record};
    if(!record.snapshot)throw new Error("Job has no resumable snapshot");
    this.resuming.add(id);
    try{
      await this.execute(record,{task:record.task,acceptanceCriteria:record.snapshot.acceptanceCriteria},signal,record.snapshot);
      return{...record};
    }finally{this.resuming.delete(id);}
  }

  async cancel(id:string):Promise<boolean>{
    const controller=this.controllers.get(id); if(!controller)return false;
    controller.abort(new Error("Job cancelled by caller")); return true;
  }

  async list():Promise<JobRecord[]>{return[...this.jobs.values()].map(x=>({...x}));}

  private async execute(
    record:JobRecord,
    input:Omit<BrainRunInput,"signal"|"resume">,
    externalSignal?:AbortSignal,
    resume?:BrainRunSnapshot,
  ){
    if(record.status==="running")return;
    record.status="running"; record.updatedAt=new Date().toISOString();
    const controller=new AbortController(); this.controllers.set(record.id,controller);
    if(externalSignal){
      if(externalSignal.aborted)controller.abort(externalSignal.reason);
      else externalSignal.addEventListener("abort",()=>controller.abort(externalSignal.reason),{once:true});
    }
    const onSnapshot=async(snapshot:BrainRunSnapshot)=>{
      record.snapshot=snapshot; record.updatedAt=new Date().toISOString(); await this.runStore?.save(snapshot);
    };
    try{
      const brain=this.brainFactory({signal:controller.signal});
      const result=await brain.run({...input,signal:controller.signal,resume});
      record.result=result;
      record.status=result.completed?"completed":result.state==="cancelled"?"cancelled":"failed";
      record.updatedAt=new Date().toISOString();
    }catch(error){
      record.error=error instanceof Error?error.message:String(error);
      record.status=controller.signal.aborted?"cancelled":"failed";
      record.updatedAt=new Date().toISOString();
    }finally{this.controllers.delete(record.id);}
  }
}
