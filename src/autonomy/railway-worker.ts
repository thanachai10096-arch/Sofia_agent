import { randomUUID } from "node:crypto";
import type { AutonomyContext } from "./controller.js";
import type { ResearchLoopAdapters } from "./research-loop.js";
import { PostgresAutonomyJobStore, type AutonomyPgPool } from "./postgres-job-store.js";
import { AutonomyJobSupervisor, type AutonomyWorkerSessionResult } from "./job-supervisor.js";
import { SofiaAutonomyRuntime, type AutonomyAuditEvent } from "./runtime.js";
import type { AutonomyJob } from "./job-store.js";

export interface RailwayAutonomyWorkerConfig<TPayload = unknown> {
  /** Trusted server-side pg-compatible pool. Never accept this from a job payload. */
  pool: AutonomyPgPool;
  /** Close the host-owned pool when the process-signal wrapper exits. */
  closePool?: () => Promise<void>;
  resolveAdapters(job: AutonomyJob<TPayload>): Promise<ResearchLoopAdapters>;
  sandboxAvailable(job: AutonomyJob<TPayload>): Promise<boolean>;
  budgetContext(job: AutonomyJob<TPayload>): AutonomyContext;
  /** Must check user, project and system kill-switch state. */
  isKilled(job: AutonomyJob<TPayload>): Promise<boolean>;
  audit?: (event: AutonomyAuditEvent) => void | Promise<void>;
  workerId?: string;
  maxJobs?: number;
  idleDelayMs?: number;
  leaseMs?: number;
  killSwitchPollMs?: number;
  maxCycles?: number;
  /** Run schema DDL only from a controlled deployment/migration process. */
  ensureSchema?: boolean;
}

/** Create a unique lease identity for one worker process/session. */
export function createRailwayWorkerInstanceId(label = "railway"): string {
  const normalized = label.trim();
  if (!normalized || normalized.length > 150) {
    throw new Error("Worker label must be between 1 and 150 characters.");
  }
  return `${normalized}:${randomUUID()}`;
}

function boundedInteger(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

/**
 * Railway-compatible worker host. The caller supplies all privileged
 * integrations; this module never invents credentials, adapters or policies.
 * It processes a bounded session and returns so the process manager can
 * restart/redeploy it. The database pool lifecycle remains host-owned.
 */
export async function runRailwayAutonomyWorker<TPayload = unknown>(
  config: RailwayAutonomyWorkerConfig<TPayload>,
  signal: AbortSignal,
): Promise<AutonomyWorkerSessionResult> {
  if (process.env.SOFIA_AUTONOMY_WORKER_ENABLED !== "true") {
    throw new Error("Autonomy worker is disabled; set SOFIA_AUTONOMY_WORKER_ENABLED=true explicitly.");
  }
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL is required for the PostgreSQL autonomy worker.");
  }
  if (typeof config.isKilled !== "function" || typeof config.resolveAdapters !== "function" ||
      typeof config.sandboxAvailable !== "function" || typeof config.budgetContext !== "function") {
    throw new Error("Trusted autonomy worker dependencies are incomplete.");
  }

  // A configured worker ID is a human-readable label, not a lease identity.
  // Append a fresh process-session nonce so a restarted replica can never
  // accidentally inherit the previous process's still-live lease ownership.
  const workerLabel = config.workerId?.trim() ||
    process.env.SOFIA_AUTONOMY_WORKER_ID?.trim() || "railway";
  const workerId = createRailwayWorkerInstanceId(workerLabel);
  const maxJobs = config.maxJobs ?? boundedInteger("SOFIA_AUTONOMY_MAX_JOBS_PER_SESSION", process.env.SOFIA_AUTONOMY_MAX_JOBS_PER_SESSION, 100, 1, 10_000);
  const idleDelayMs = config.idleDelayMs ?? boundedInteger("SOFIA_AUTONOMY_IDLE_DELAY_MS", process.env.SOFIA_AUTONOMY_IDLE_DELAY_MS, 2_000, 100, 60_000);
  const leaseMs = config.leaseMs ?? 30_000;
  const killSwitchPollMs = config.killSwitchPollMs ?? boundedInteger("SOFIA_AUTONOMY_KILL_SWITCH_POLL_MS", process.env.SOFIA_AUTONOMY_KILL_SWITCH_POLL_MS, 5_000, 1_000, 60_000);

  if (typeof config.pool.query !== "function" || typeof config.pool.connect !== "function") {
    throw new Error("A valid trusted PostgreSQL pool is required.");
  }
  // Fail startup immediately rather than entering the worker retry loop with a dead database.
  await config.pool.query("SELECT 1");
  const store = new PostgresAutonomyJobStore(config.pool);
  if (config.ensureSchema) await store.ensureSchema();

  const runtime = new SofiaAutonomyRuntime({ audit: config.audit });
  const supervisor = new AutonomyJobSupervisor<TPayload>({
    store,
    executor: runtime,
    resolveAdapters: config.resolveAdapters,
    sandboxAvailable: config.sandboxAvailable,
    budgetContext: config.budgetContext,
    isKilled: config.isKilled,
    leaseMs,
    killSwitchPollMs,
    ...(config.maxCycles !== undefined ? { maxCycles: config.maxCycles } : {}),
  });
  return supervisor.runUntilStopped(workerId, signal, {
    maxJobs,
    idleDelayMs,
    maxConsecutiveErrors: 5,
  });
}

/** Bind Railway/container termination signals to an abortable worker session. */
export async function runRailwayAutonomyWorkerWithProcessSignals<TPayload = unknown>(
  config: RailwayAutonomyWorkerConfig<TPayload>,
  signalSource: Pick<NodeJS.Process, "once" | "removeListener"> = process,
): Promise<AutonomyWorkerSessionResult> {
  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    if (!controller.signal.aborted) controller.abort(new Error(`Received ${signal}; graceful shutdown requested.`));
  };
  const onSigterm = () => stop("SIGTERM");
  const onSigint = () => stop("SIGINT");
  signalSource.once("SIGTERM", onSigterm);
  signalSource.once("SIGINT", onSigint);
  try {
    return await runRailwayAutonomyWorker(config, controller.signal);
  } finally {
    signalSource.removeListener("SIGTERM", onSigterm);
    signalSource.removeListener("SIGINT", onSigint);
    await config.closePool?.();
  }
}
