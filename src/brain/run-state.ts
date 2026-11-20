import type {
  Diagnosis,
  ExecutionPlan,
  Observation,
  TaskUnderstanding,
  AcceptanceCriterion,
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
  acceptanceCriteria: AcceptanceCriterion[];
  completedStepIds: string[];
  /** A tool call may have produced external side effects before a crash. */
  inFlightStepId?: string;
  /** Explicit human reconciliation decisions for interrupted tool calls. */
  reconciliations?: Array<{
    stepId: string;
    outcome: "completed" | "retry";
    decidedAt: string;
    actorId: string;
    note?: string;
    confirmedNoSideEffect?: true;
  }>;
  checkpointId: string;
  baselineSnapshotId?: string;
  usage: BrainRunUsageSnapshot;
  observations: Observation[];
  diagnoses: Diagnosis[];
  decisions: Array<{ strategy: ExecutionPlan["strategy"]; reason: string }>;
  recoveryRounds: number;
  trace: ExecutionTraceEntry[];
}
