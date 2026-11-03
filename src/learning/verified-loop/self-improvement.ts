import type { LearningScope } from "./ports.js";
import type { VerifiedLearningLoop } from "./loop.js";

export interface VerifiedExecutionNotification {
  sequence: number;
  receiptId: string;
  summary: string;
}
export interface SelfImprovementCheckpointState {
  lastSequence: number;
  pending: VerifiedExecutionNotification[];
  /** Monotonic store revision, present on stores that support compare-and-set. */
  revision?: number;
}
export interface SelfImprovementCheckpointStore {
  /** Persist cursor atomically with delivery identity; implementation must be durable. */
  read(scope: LearningScope): Promise<SelfImprovementCheckpointState>;
  write(scope: LearningScope, state: { lastSequence: number; pending: VerifiedExecutionNotification[] }): Promise<void>;
  /** Atomically update only if the durable revision still matches the observed revision. */
  compareAndSet?(scope: LearningScope, expectedRevision: number, state: { lastSequence: number; pending: VerifiedExecutionNotification[] }): Promise<boolean>;
}
export interface SelfImprovementOptions {
  scope: LearningScope;
  loop: VerifiedLearningLoop;
  checkpoints: SelfImprovementCheckpointStore;
  redact: (text: string) => string;
}

/**
 * Adapter for trusted finalized-run notifications. Supply only events emitted after
 * Sofia's authoritative verifier has persisted its receipt. The checkpoint adapter
 * is responsible for durable atomic writes; this class never claims in-memory state
 * survives a restart.
 */
export class ScopedSelfImprovement {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly options: SelfImprovementOptions) {}

  onVerifiedExecution(notification: VerifiedExecutionNotification): Promise<void> {
    if (!Number.isSafeInteger(notification.sequence) || notification.sequence < 1 ||
        typeof notification.receiptId !== "string" || !notification.receiptId.trim() ||
        typeof notification.summary !== "string") {
      return Promise.reject(new Error("Invalid verified execution notification"));
    }
    const safe = { ...notification, summary: this.options.redact(notification.summary).slice(0, 1200) };
    const task = this.tail.then(() => this.process(safe));
    this.tail = task.catch(() => undefined);
    return task;
  }

  private async process(notification: VerifiedExecutionNotification): Promise<void> {
    const { scope, checkpoints, loop } = this.options;
    // Revision CAS prevents independent processes from overwriting newer cursor
    // or pending-event state with a stale snapshot. Learning writes are idempotent
    // by (scope, receiptId), so a losing worker can safely reload and recompute.
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const state = await checkpoints.read(scope);
      if (!Number.isSafeInteger(state.lastSequence) || state.lastSequence < 0 ||
          (state.revision !== undefined && (!Number.isSafeInteger(state.revision) || state.revision < 0))) {
        throw new Error("Invalid self-improvement checkpoint");
      }
      const pending = new Map(state.pending.map(item => [item.sequence, item]));
      const existingAtSequence = pending.get(notification.sequence);
      if (existingAtSequence && existingAtSequence.receiptId !== notification.receiptId) {
        throw new Error("Conflicting receipt IDs for the same pending sequence");
      }
      const existingSequenceForReceipt = [...pending.values()].find(item =>
        item.receiptId === notification.receiptId && item.sequence !== notification.sequence);
      if (existingSequenceForReceipt) {
        throw new Error("Receipt ID is already assigned to a different pending sequence");
      }
      if (notification.sequence <= state.lastSequence) return;
      pending.set(notification.sequence, notification);
      let cursor = state.lastSequence;
      while (pending.has(cursor + 1)) {
        const next = pending.get(cursor + 1)!;
        await loop.recordVerifiedCompletion(scope, next.receiptId, next.summary);
        pending.delete(cursor + 1);
        cursor += 1;
      }
      const nextState = { lastSequence: cursor, pending: [...pending.values()].sort((a, b) => a.sequence - b.sequence) };
      if (checkpoints.compareAndSet && state.revision !== undefined) {
        if (await checkpoints.compareAndSet(scope, state.revision, nextState)) return;
        continue;
      }
      await checkpoints.write(scope, nextState);
      return;
    }
    throw new Error("Self-improvement checkpoint changed repeatedly; retry delivery later");
  }

  /** Retry retained out-of-order notifications after missing deliveries arrive. */
  async recoverPending(): Promise<void> {
    const { scope, checkpoints } = this.options;
    const state = await checkpoints.read(scope);
    const next = state.pending.find(item => item.sequence === state.lastSequence + 1);
    if (next) await this.onVerifiedExecution(next);
  }
}
