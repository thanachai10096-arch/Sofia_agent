import type { AutonomyContext } from "./controller.js";
import type { ResearchLoopAdapters, ResearchLoopReport } from "./research-loop.js";
import type { AutonomyJob, AutonomyJobStore } from "./job-store.js";
import type { AutonomyResearchRequest } from "./runtime.js";

export interface AutonomyResearchExecutor {
  runResearch(request: AutonomyResearchRequest): Promise<ResearchLoopReport>;
}

export interface AutonomyJobSupervisorOptions<TPayload = unknown> {
  store: AutonomyJobStore;
  executor: AutonomyResearchExecutor;
  /** Resolve adapters from trusted server configuration, never job payload code. */
  resolveAdapters(job: AutonomyJob<TPayload>): Promise<ResearchLoopAdapters>;
  sandboxAvailable(job: AutonomyJob<TPayload>): Promise<boolean>;
  budgetContext(job: AutonomyJob<TPayload>): AutonomyContext;
  leaseMs?: number;
  maxCycles?: number;
}

/** Executes at most one durable job per call; scheduling remains host-owned. */
export class AutonomyJobSupervisor<TPayload = unknown> {
  private readonly leaseMs;

  constructor(private readonly options: AutonomyJobSupervisorOptions<TPayload>) {
    this.leaseMs = options.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 3_000 || this.leaseMs > 300_000) {
      throw new Error("Autonomy worker lease must be between 3s and 5m.");
    }
  }

  async runNext(workerId: string, signal: AbortSignal): Promise<AutonomyJob | undefined> {
    if (signal.aborted) return undefined;
    await this.options.store.recoverExpired();
    const job = await this.options.store.claimNext<TPayload>(workerId, this.leaseMs);
    if (!job) return undefined;

    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal.reason ?? new Error("Worker shutdown requested."));
    signal.addEventListener("abort", forwardAbort, { once: true });
    if (signal.aborted) forwardAbort();
    const heartbeat = setInterval(() => {
      void this.options.store.heartbeat(job.principalId, job.id, workerId, this.leaseMs)
        .catch((error: unknown) => controller.abort(error instanceof Error ? error : new Error("Job lease heartbeat failed.")));
    }, Math.max(1_000, Math.floor(this.leaseMs / 3)));

    try {
      const [adapters, sandboxAvailable] = await Promise.all([
        this.options.resolveAdapters(job),
        this.options.sandboxAvailable(job),
      ]);
      controller.signal.throwIfAborted();
      const report = await this.options.executor.runResearch({
        principalId: job.principalId,
        signal: controller.signal,
        adapters,
        sandboxAvailable,
        budgetContext: () => this.options.budgetContext(job),
        ...(this.options.maxCycles !== undefined ? { maxCycles: this.options.maxCycles } : {}),
        ...(job.checkpoint ? {
          startCycle: job.checkpoint.nextCycle,
          previousCycles: job.checkpoint.cycles as ResearchLoopReport["cycles"],
        } : {}),
        onCycle: async (cycle, nextCycle) => {
          const previous = job.checkpoint?.cycles ?? [];
          await this.options.store.saveCheckpoint(job.principalId, job.id, workerId, {
            nextCycle,
            cycles: [...previous, cycle],
          });
          if (job.checkpoint) {
            job.checkpoint.nextCycle = nextCycle;
            job.checkpoint.cycles = [...previous, cycle];
          } else {
            job.checkpoint = { nextCycle, cycles: [cycle], updatedAt: new Date().toISOString() };
          }
        },
      });
      if (controller.signal.aborted || report.stoppedBy === "aborted") {
        return await this.options.store.cancel(job.principalId, job.id);
      }
      return await this.options.store.complete(job.principalId, job.id, workerId, report);
    } catch (error) {
      if (controller.signal.aborted || signal.aborted) {
        return await this.options.store.cancel(job.principalId, job.id);
      }
      return await this.options.store.fail(
        job.principalId, job.id, workerId,
        error instanceof Error ? error.message : "Unknown autonomy worker failure", true,
      );
    } finally {
      clearInterval(heartbeat);
      signal.removeEventListener("abort", forwardAbort);
    }
  }
}
