import type { SubagentRequest, SubagentResult, SubagentRuntime, SubagentRole } from "./subagents.js";

export interface SubagentTask {
  id: string;
  role: SubagentRole;
  task: string;
  context?: Record<string, unknown>;
}
export interface SubagentBatchItem {
  taskId: string;
  result?: SubagentResult;
  error?: string;
}
export interface SubagentCoordinatorOptions {
  maxConcurrency?: number;
  maxTasks?: number;
  timeoutMs?: number;
  maxContextBytes?: number;
}
export type SubagentRuntimeFactory = (task: Readonly<SubagentTask>) => SubagentRuntime;

function cloneBoundedContext(context: Record<string, unknown> | undefined, maxBytes: number): Record<string, unknown> {
  if (context === undefined) return {};
  let serialized: string;
  try { serialized = JSON.stringify(context); }
  catch { throw new Error("Subagent context must be JSON-serializable"); }
  if (typeof serialized !== "string") throw new Error("Subagent context must be JSON-serializable");
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) throw new Error("Subagent context exceeds configured size limit");
  const cloned: unknown = JSON.parse(serialized);
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) throw new Error("Subagent context must be a JSON object");
  return cloned as Record<string, unknown>;
}

/**
 * Runs independent child tasks with fresh runtimes and bounded concurrency.
 * The factory must construct each child with its own context and least-privilege tool set.
 */
export class BoundedSubagentCoordinator {
  private readonly maxConcurrency: number;
  private readonly maxTasks: number;
  private readonly timeoutMs: number;
  private readonly maxContextBytes: number;
  // Shared by every runMany() call on this coordinator, not reset per batch.
  private activeTasks = 0;
  private readonly slotWaiters: Array<{
    signal: AbortSignal;
    resolve: () => void;
    reject: (reason: unknown) => void;
    onAbort: () => void;
  }> = [];

  private async acquireSlot(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.activeTasks < this.maxConcurrency) {
      this.activeTasks += 1;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const waiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.slotWaiters.indexOf(waiter);
          if (index >= 0) this.slotWaiters.splice(index, 1);
          reject(signal.reason instanceof Error ? signal.reason : new Error("Subagent task aborted"));
        },
      };
      this.slotWaiters.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      // Close the race where cancellation occurs between the initial check and
      // registration of the abort listener.
      if (signal.aborted) waiter.onAbort();
    });
  }

  private releaseSlot(): void {
    while (this.slotWaiters.length > 0) {
      const waiter = this.slotWaiters.shift()!;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason instanceof Error ? waiter.signal.reason : new Error("Subagent task aborted"));
        continue;
      }
      // Transfer the occupied slot directly to the next waiter.
      waiter.resolve();
      return;
    }
    this.activeTasks = Math.max(0, this.activeTasks - 1);
  }

  constructor(private readonly createRuntime: SubagentRuntimeFactory, options: SubagentCoordinatorOptions = {}) {
    this.maxConcurrency = options.maxConcurrency ?? 3;
    this.maxTasks = options.maxTasks ?? 12;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxContextBytes = options.maxContextBytes ?? 32 * 1024;
    if (!Number.isSafeInteger(this.maxConcurrency) || this.maxConcurrency < 1 || this.maxConcurrency > 8) throw new Error("maxConcurrency must be between 1 and 8");
    if (!Number.isSafeInteger(this.maxTasks) || this.maxTasks < 1 || this.maxTasks > 100) throw new Error("maxTasks must be between 1 and 100");
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 300_000) throw new Error("timeoutMs must be between 100 and 300000");
    if (!Number.isSafeInteger(this.maxContextBytes) || this.maxContextBytes < 256 || this.maxContextBytes > 1_048_576) throw new Error("maxContextBytes must be between 256 and 1048576");
  }

  async runMany(tasks: readonly SubagentTask[], parentSignal: AbortSignal): Promise<SubagentBatchItem[]> {
    if (tasks.length > this.maxTasks) throw new Error("Subagent batch exceeds configured maxTasks");
    const ids = new Set<string>();
    for (const task of tasks) {
      if (!task.id.trim() || !task.task.trim()) throw new Error("Each subagent task requires a non-empty id and task");
      if (ids.has(task.id)) throw new Error("Duplicate subagent task id: " + task.id);
      ids.add(task.id);
    }
    const results = new Array<SubagentBatchItem | undefined>(tasks.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const index = next++;
        if (index >= tasks.length) return;
        const task = tasks[index]!;
        let acquired = false;
        try {
          parentSignal.throwIfAborted();
          await this.acquireSlot(parentSignal);
          acquired = true;
          // Cancellation may race with the await even when a slot was immediately available.
          parentSignal.throwIfAborted();
          const context = cloneBoundedContext(task.context, this.maxContextBytes);
          const controller = new AbortController();
          const abortParent = () => controller.abort(parentSignal.reason);
          parentSignal.addEventListener("abort", abortParent, { once: true });
          const timer = setTimeout(() => controller.abort(new Error("Subagent task timed out")), this.timeoutMs);
          let onAbort: (() => void) | undefined;
          try {
            const runtime = this.createRuntime(task);
            const operation = runtime.run({ role: task.role, task: task.task, context, signal: controller.signal });
            const aborted = new Promise<never>((_, reject) => {
              onAbort = () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error("Subagent task aborted"));
              if (controller.signal.aborted) onAbort();
              else controller.signal.addEventListener("abort", onAbort, { once: true });
            });
            const result = await Promise.race([operation, aborted]);
            results[index] = { taskId: task.id, result };
          } finally {
            clearTimeout(timer);
            parentSignal.removeEventListener("abort", abortParent);
            if (onAbort) controller.signal.removeEventListener("abort", onAbort);
          }
        } catch (error) {
          results[index] = { taskId: task.id, error: error instanceof Error ? error.message : String(error) };
        } finally {
          if (acquired) this.releaseSlot();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.maxConcurrency, Math.max(1, tasks.length)) }, worker));
    return results.map((item, index) => item ?? {
      taskId: tasks[index]!.id,
      error: parentSignal.aborted ? "Parent task aborted" : "Subagent task did not produce a result",
    });
  }
}
