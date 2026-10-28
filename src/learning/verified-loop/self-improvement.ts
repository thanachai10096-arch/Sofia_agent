import type { LearningScope } from "./ports.js";
import type { VerifiedLearningLoop } from "./loop.js";

export interface VerifiedExecutionNotification {
  sequence: number;
  receiptId: string;
  summary: string;
}
export interface SelfImprovementCheckpointStore {
  /** Persist cursor atomically with delivery identity; implementation must be durable. */
  read(scope: LearningScope): Promise<{ lastSequence: number; pending: VerifiedExecutionNotification[] }>;
  write(scope: LearningScope, state: { lastSequence: number; pending: VerifiedExecutionNotification[] }): Promise<void>;
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
        typeof notification.receiptId !== "string" || !notification.receiptId.trim()) {
      return Promise.reject(new Error("Invalid verified execution notification"));
    }
    const safe = { ...notification, summary: this.options.redact(notification.summary).slice(0, 1200) };
    const task = this.tail.then(() => this.process(safe));
    this.tail = task.catch(() => undefined);
    return task;
  }

  private async process(notification: VerifiedExecutionNotification): Promise<void> {
    const { scope, checkpoints, loop } = this.options;
    const state = await checkpoints.read(scope);
    if (!Number.isSafeInteger(state.lastSequence) || state.lastSequence < 0) throw new Error("Invalid self-improvement checkpoint");
    const pending = new Map(state.pending.map(item => [item.sequence, item]));
    // Duplicate delivery is idempotent; a future event is retained until the gap arrives.
    if (notification.sequence > state.lastSequence + 1) {
      pending.set(notification.sequence, notification);
      await checkpoints.write(scope, { lastSequence: state.lastSequence, pending: [...pending.values()].sort((a,b) => a.sequence-b.sequence) });
      return;
    }
    if (notification.sequence <= state.lastSequence) return;
    pending.set(notification.sequence, notification);
    let cursor = state.lastSequence;
    while (pending.has(cursor + 1)) {
      const next = pending.get(cursor + 1)!;
      // A false/untrusted receipt is a no-op but its sequence is consumed so a
      // malformed event cannot block all future learning forever.
      await loop.recordVerifiedCompletion(scope, next.receiptId, next.summary);
      pending.delete(cursor + 1);
      cursor += 1;
    }
    await checkpoints.write(scope, { lastSequence: cursor, pending: [...pending.values()].sort((a,b) => a.sequence-b.sequence) });
  }

  /** Retry retained out-of-order notifications after missing deliveries arrive. */
  async recoverPending(): Promise<void> {
    const { scope, checkpoints } = this.options;
    const state = await checkpoints.read(scope);
    const next = state.pending.find(item => item.sequence === state.lastSequence + 1);
    if (next) await this.onVerifiedExecution(next);
  }
}
