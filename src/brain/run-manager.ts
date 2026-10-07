import type { BrainRunInput, SofiaBrain } from "./executor.js";
import type { RunStore } from "./run-store.js";
import { DurableJobRuntime, type JobRecord, type JobRuntime } from "./job-runtime.js";

export type ManagedRun=JobRecord;
export interface RunManager extends JobRuntime {}
export class InMemoryRunManager extends DurableJobRuntime implements RunManager {
  constructor(brainFactory:(options:{signal?:AbortSignal;maxSteps?:number})=>SofiaBrain,runStore?:RunStore){super(brainFactory,runStore);}
  async create(input:Omit<BrainRunInput,"signal"|"resume">):Promise<ManagedRun>{return this.submit(input);}
}
