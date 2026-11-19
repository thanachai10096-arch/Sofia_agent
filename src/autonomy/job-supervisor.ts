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
  isKilled(job: AutonomyJob<TPayload>): Promise<boolean>;
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
    let abortKind: "host" | "safety" | "lease-lost" | "user-cancel" | undefined;
    const forwardAbort = () => { abortKind = "host"; controller.abort(signal.reason ?? new Error("Worker shutdown requested.")); };
    signal.addEventListener("abort", forwardAbort, { once: true });
    if (signal.aborted) forwardAbort();
    let safetyPollInFlight = false;
    let heartbeatInFlight = false;
    const pollKillSwitch = async () => {
      if (controller.signal.aborted || safetyPollInFlight) return;
      safetyPollInFlight = true;
      try {
        const current = await this.options.store.get(job.principalId, job.id);
        if (!current || current.status !== "running" || current.lease?.workerId !== workerId) {
          abortKind = current?.status === "cancelled" ? "user-cancel" : "lease-lost";
          controller.abort(new Error("Autonomy job was cancelled or its lease is no longer owned."));
          return;
        }
        const killed = await this.options.isKilled(job);
        if (killed !== false) {
          abortKind = "safety";
          controller.abort(new Error("Autonomy kill switch is active or returned an invalid result."));
        }
      } catch {
        abortKind = "safety";
        controller.abort(new Error("Autonomy cancellation or kill-switch check failed."));
      } finally {
        safetyPollInFlight = false;
      }
    };
    await pollKillSwitch();
    if (controller.signal.aborted) {
      signal.removeEventListener("abort", forwardAbort);
      return abortKind === "lease-lost" || abortKind === "user-cancel"
        ? (await this.options.store.get(job.principalId, job.id))
        : this.options.store.cancelOwned(job.principalId, job.id, workerId);
    }
    const killPoll = setInterval(() => { void pollKillSwitch(); }, this.killSwitchPollMs);
    const heartbeat = setInterval(() => {
      if (heartbeatInFlight || controller.signal.aborted) return;
      heartbeatInFlight = true;
      void this.options.store.heartbeat(job.principalId, job.id, workerId, this.leaseMs)
        .catch((error: unknown) => {
          abortKind = "lease-lost";
          controller.abort(error instanceof Error ? error : new Error("Job lease heartbeat failed."));
        })
        .finally(() => { heartbeatInFlight = false; });
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
        return abortKind === "lease-lost" || abortKind === "user-cancel"
          ? (await this.options.store.get(job.principalId, job.id))
          : await this.options.store.cancelOwned(job.principalId, job.id, workerId);
      }
      try {
        return await this.options.store.complete(job.principalId, job.id, workerId, report);
      } catch (completionError) {
        // A user cancellation or lease recovery can win immediately after the
        // final safety poll. Never turn that terminal/rerouted state into a
        // worker error or attempt a stale failure write.
        const current = await this.options.store.get(job.principalId, job.id);
        if (current && (current.status !== "running" || current.lease?.workerId !== workerId)) {
          return current;
        }
        throw completionError;
      }
    } catch {
      if (controller.signal.aborted || signal.aborted) {
        return abortKind === "lease-lost" || abortKind === "user-cancel"
          ? (await this.options.store.get(job.principalId, job.id))
          : await this.options.store.cancelOwned(job.principalId, job.id, workerId);
      }
      // Adapter/provider errors can contain credentials, connection strings or user data.
      // Keep public job records safe; never persist raw exception messages.
      return await this.options.store.fail(
        job.principalId, job.id, workerId, "Autonomy job failed.", true,
      );
    } finally {
      clearInterval(heartbeat);
      clearInterval(killPoll);
      signal.removeEventListener("abort", forwardAbort);
    }
  }
}
