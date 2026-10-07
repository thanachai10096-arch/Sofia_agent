import type {
  Diagnosis,
  ExecutionPlan,
  Observation,
  TaskUnderstanding,
} from "./types.js";
import type { ExecutionTraceEntry } from "./execution-trace.js";

export interface BrainRunUsageSnapshot {
  steps: number;
  toolCalls: number;
  modelCalls: number;
  reservedOrUsedTokens: number;
  replans: number;
}

export interface BrainRunSnapshot {
  version: 1;
  runId: string;
  task: string;
  understanding: TaskUnderstanding;
  plan: ExecutionPlan;
  completedStepIds: string[];
  checkpointId: string;
  baselineSnapshotId?: string;
  usage: BrainRunUsageSnapshot;
  observations: Observation[];
  diagnoses: Diagnosis[];
  decisions: Array<{ strategy: ExecutionPlan["strategy"]; reason: string }>;
  recoveryRounds: number;
  trace: ExecutionTraceEntry[];
}
