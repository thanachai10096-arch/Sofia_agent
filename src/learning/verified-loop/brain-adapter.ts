import type { LearningScope } from "./ports.js";
import type { VerifiedLearningLoop } from "./loop.js";
import { ScopedSelfImprovement, type SelfImprovementCheckpointStore } from "./self-improvement.js";

export interface FinalizedBrainCompletion {
  runId: string;
  principalId?: string;
  task: string;
  evidenceIds: string[];
  verification: Array<{ criterionId: string; passed: boolean; detail: string; evidenceIds: string[]; workspaceRevision: string }>;
}
export interface PersistedCompletionReceipt { receiptId: string; sequence: number; }

/**
 * Bridge for SofiaBrain's onVerifiedCompletion callback.
 * persistFinalizedReceipt MUST independently verify and persist the authoritative,
 * scoped receipt; Brain callback payloads alone are not accepted as durable evidence.
 */
export function createVerifiedCompletionHandler(options: {
  loop: VerifiedLearningLoop;
  resolveScope: (input: FinalizedBrainCompletion) => Promise<LearningScope>;
  persistFinalizedReceipt: (input: FinalizedBrainCompletion, scope: LearningScope) => Promise<PersistedCompletionReceipt>;
  checkpoints: SelfImprovementCheckpointStore;
  redact: (text: string) => string;
}): (input: FinalizedBrainCompletion) => Promise<void> {
  const workers = new Map<string, ScopedSelfImprovement>();
  return async (input) => {
    if (!input.runId || !input.task.trim() || input.evidenceIds.length === 0 ||
        input.verification.length === 0 ||
        !input.verification.every(item => item.passed && item.evidenceIds.length > 0)) return;

    const scope = await options.resolveScope(input);
    const key = [scope.tenantId, scope.principalId, scope.projectId].join(":");
    let worker = workers.get(key);
    if (!worker) {
      worker = new ScopedSelfImprovement({
        scope, loop: options.loop, checkpoints: options.checkpoints, redact: options.redact,
      });
      workers.set(key, worker);
    }
    const persisted = await options.persistFinalizedReceipt(input, scope);
    if (!Number.isSafeInteger(persisted.sequence) || persisted.sequence < 1 || !persisted.receiptId) {
      throw new Error("Receipt adapter returned invalid sequence or receipt id");
    }
    await worker.onVerifiedExecution({
      sequence: persisted.sequence, receiptId: persisted.receiptId, summary: input.task,
    });
  };
}
