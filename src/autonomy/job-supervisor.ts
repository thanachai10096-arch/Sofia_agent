import { setTimeout as delay } from "node:timers/promises";
import type { AutonomyContext } from "./controller.js";
import type { ResearchLoopAdapters, ResearchLoopReport } from "./research-loop.js";
import type { AutonomyJob, AutonomyJobStore } from "./job-store.js";
import type { AutonomyResearchRequest } from "./runtime.js";

export interface AutonomyWorkerSessionOptions {
  /** Maximum jobs processed before the host restarts or re-invokes the worker. */
  maxJobs?: number;
  idleDelayMs?: number;
  maxConsecutiveErrors?: number;
}
export interface AutonomyWorkerSessionResult {
  processed: number;
  infrastructureErrors: number;
  stoppedBy: "aborted" | "max-jobs" | "worker-error";
}

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
  /** Host-owned user/project/system kill switch; never model-controlled. */
  isKilled?(job: AutonomyJob<TPayload>): Promise<boolean>;
  killSwitchPollMs?: number;
  leaseMs?: number;
  maxCycles?: number;
}

/** Executes at most one durable job per call; scheduling remains host-owned. */
export class AutonomyJobSupervisor<TPayload = unknown> {
  private readonly leaseMs;
  private readonly killSwitchPollMs;

  constructor(private readonly options: AutonomyJobSupervisorOptions<TPayload>) {
    this.leaseMs = options.leaseMs ?? 30_000;
    this.killSwitchPollMs = options.killSwitchPollMs ?? 5_000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 3_000 || this.leaseMs > 300_000) {
      throw new Error("Autonomy worker lease must be between 3s and 5m.");
    }
    if (!Number.isSafeInteger(this.killSwitchPollMs) || this.killSwitchPollMs < 1_000 || this.killSwitchPollMs > 60_000) {
      throw new Error("Kill-switch polling interval must be between 1s and 60s.");
    }
  }

  /**
   * Host-invoked worker session with bounded polling, idle backoff and graceful
   * cancellation. Process managers (Railway, containers, etc.) own restarts.
   */
  async runUntilStopped(
    workerId: string,
    signal: AbortSignal,
    session: AutonomyWorkerSessionOptions = {},
  ): Promise<AutonomyWorkerSessionResult> {
    const maxJobs = session.maxJobs ?? 100;
    const idleDelayMs = session.idleDelayMs ?? 2_000;
    const maxConsecutiveErrors = session.maxConsecutiveErrors ?? 5;
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 10_000 ||
        !Number.isSafeInteger(idleDelayMs) || idleDelayMs < 100 || idleDelayMs > 60_000 ||
        !Number.isSafeInteger(maxConsecutiveErrors) || maxConsecutiveErrors < 1 || maxConsecutiveErrors > 20) {
      throw new Error("Invalid autonomy worker session limits.");
    }
    let processed = 0;
    let infrastructureErrors = 0;
    let consecutiveErrors = 0;
    while (!signal.aborted && processed < maxJobs) {
      try {
        const job = await this.runNext(workerId, signal);
        consecutiveErrors = 0;
        if (job) processed += 1;
        else await delay(idleDelayMs, undefined, { signal }).catch(() => undefined);
      } catch {
        infrastructureErrors += 1;
        consecutiveErrors += 1;
        if (consecutiveErrors >= maxConsecutiveErrors) {
          return { processed, infrastructureErrors, stoppedBy: "worker-error" };
        }
        await delay(Math.min(idleDelayMs * consecutiveErrors, 60_000), undefined, { signal }).catch(() => undefined);
      }
    }
    return {
      processed,
      infrastructureErrors,
      stoppedBy: signal.aborted ? "aborted" : "max-jobs",
    };
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
    const pollKillSwitch = async () => {
      if (!this.options.isKilled || controller.signal.aborted) return;
      try {
        if (await this.options.isKilled(job)) controller.abort(new Error("Autonomy kill switch activated."));
      } catch {
        // Fail closed: an unavailable kill-switch authority stops autonomous work.
        controller.abort(new Error("Autonomy kill-switch check failed."));
      }
    };
    await pollKillSwitch();
    if (controller.signal.aborted) {
      signal.removeEventListener("abort", forwardAbort);
      return this.options.store.cancel(job.principalId, job.id);
    }
    const killPoll = setInterval(() => { void pollKillSwitch(); }, this.killSwitchPollMs);
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
        idempotencyPrefix: `autonomy-job:${job.id}`,
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
      clearInterval(killPoll);
      signal.removeEventListener("abort", forwardAbort);
    }
  }
}
