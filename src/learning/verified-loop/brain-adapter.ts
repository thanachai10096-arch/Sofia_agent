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
    const validEvidenceIds = (value: unknown): value is string[] =>
      Array.isArray(value) && value.length > 0 &&
      value.every(id => typeof id === "string" && id.trim().length > 0 && id.length <= 500);
    if (!input || typeof input !== "object" ||
        typeof input.runId !== "string" || !input.runId.trim() ||
        typeof input.task !== "string" || !input.task.trim() ||
        !validEvidenceIds(input.evidenceIds) ||
        !Array.isArray(input.verification) || input.verification.length === 0 ||
        !input.verification.every(item =>
          Boolean(item) && typeof item === "object" && item.passed === true &&
          validEvidenceIds(item.evidenceIds) &&
          typeof item.criterionId === "string" && item.criterionId.trim().length > 0 &&
          typeof item.workspaceRevision === "string" && item.workspaceRevision.trim().length > 0)) return;

    const scope = await options.resolveScope(input);
    if (!scope || ![scope.tenantId, scope.principalId, scope.projectId].every(value => typeof value === "string" && value.trim().length > 0)) throw new Error("Scope resolver returned an invalid authenticated scope");
    const key = JSON.stringify([scope.tenantId, scope.principalId, scope.projectId]);
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
