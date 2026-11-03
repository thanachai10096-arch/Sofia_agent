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
export interface PersistedCompletionDelivery extends PersistedCompletionReceipt { summary: string; }
export type VerifiedCompletionHandler = ((input: FinalizedBrainCompletion) => Promise<void>) & {
  /** Replay durable receipts after a crash. The host must return all receipts after the supplied cursor in ascending sequence order. */
  recover(scope: LearningScope): Promise<number>;
};

/**
 * Bridge for SofiaBrain's onVerifiedCompletion callback.
 * persistFinalizedReceipt MUST independently verify and persist the authoritative,
 * scoped receipt; Brain callback payloads alone are not accepted as durable evidence.
 */
export function createVerifiedCompletionHandler(options: {
  loop: VerifiedLearningLoop;
  resolveScope: (input: FinalizedBrainCompletion) => Promise<LearningScope>;
  persistFinalizedReceipt: (input: FinalizedBrainCompletion, scope: LearningScope) => Promise<PersistedCompletionReceipt>;
  /** Query the authoritative receipt store, not the learning database or callback memory. */
  listFinalizedReceipts?: (scope: LearningScope, afterSequence: number) => Promise<PersistedCompletionDelivery[]>;
  checkpoints: SelfImprovementCheckpointStore;
  redact: (text: string) => string;
}): VerifiedCompletionHandler {
  const workers = new Map<string, ScopedSelfImprovement>();
  const workerFor = (scope: LearningScope): ScopedSelfImprovement => {
    const key = JSON.stringify([scope.tenantId, scope.principalId, scope.projectId]);
    let worker = workers.get(key);
    if (!worker) {
      worker = new ScopedSelfImprovement({
        scope, loop: options.loop, checkpoints: options.checkpoints, redact: options.redact,
      });
      workers.set(key, worker);
    }
    return worker;
  };
  const handler = (async (input: FinalizedBrainCompletion) => {
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
    // The callback's principal is untrusted metadata, not an authority source.
    if (input.principalId !== undefined &&
        (typeof input.principalId !== "string" || input.principalId !== scope.principalId)) {
      throw new Error("Verified completion principal does not match authenticated learning scope");
    }
    const persisted: PersistedCompletionReceipt = await options.persistFinalizedReceipt(input, scope);
    if (!persisted || !Number.isSafeInteger(persisted.sequence) || persisted.sequence < 1 ||
        typeof persisted.receiptId !== "string" || !persisted.receiptId.trim() || persisted.receiptId.length > 500) {
      throw new Error("Receipt adapter returned invalid sequence or receipt id");
    }
    await workerFor(scope).onVerifiedExecution({
      sequence: persisted.sequence, receiptId: persisted.receiptId, summary: input.task,
    });
  }) as VerifiedCompletionHandler;

  handler.recover = async (scope: LearningScope): Promise<number> => {
    if (!options.listFinalizedReceipts) throw new Error("Authoritative finalized-receipt recovery is not configured");
    if (!scope || ![scope.tenantId, scope.principalId, scope.projectId].every(value => typeof value === "string" && value.trim().length > 0)) {
      throw new Error("Invalid authenticated learning scope for recovery");
    }
    const checkpoint = await options.checkpoints.read(scope);
    if (!checkpoint || !Number.isSafeInteger(checkpoint.lastSequence) || checkpoint.lastSequence < 0) {
      throw new Error("Invalid self-improvement checkpoint during recovery");
    }
    const receipts = await options.listFinalizedReceipts(scope, checkpoint.lastSequence);
    if (!Array.isArray(receipts)) throw new Error("Receipt recovery adapter returned an invalid result");
    // The authoritative adapter contract requires ascending sequence order. Do not sort malformed input into apparent validity.
    const ordered = [...receipts];
    let previous = checkpoint.lastSequence;
    for (const receipt of ordered) {
      if (!receipt || !Number.isSafeInteger(receipt.sequence) || receipt.sequence <= previous ||
          typeof receipt.receiptId !== "string" || !receipt.receiptId.trim() || receipt.receiptId.length > 500 ||
          typeof receipt.summary !== "string" || !receipt.summary.trim()) {
        throw new Error("Receipt recovery adapter returned malformed or duplicate sequence data");
      }
      previous = receipt.sequence;
    }
    const worker = workerFor(scope);
    let delivered = 0;
    for (const receipt of ordered) {
      await worker.onVerifiedExecution({
        sequence: receipt.sequence, receiptId: receipt.receiptId, summary: receipt.summary,
      });
      delivered += 1;
    }
    await worker.recoverPending();
    return delivered;
  };
  return handler;
}
