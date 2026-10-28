import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { JobRecord, JobRuntime } from "./job-runtime.js";
import { sofiaStateDirectory } from "../platform/state-directory.js";
import { redactSecrets } from "../security/guard.js";

export type ContinuousWorkStatus = "active" | "paused" | "stopped" | "completed" | "failed";
export interface ContinuousWorkRecord {
  id: string; ownerKeyId: string; task: string; status: ContinuousWorkStatus;
  iteration: number; maxIterationsPerActivation: number; maxLifetimeIterations?: number;
  currentJobId?: string; lastSummary?: string; lastError?: string; createdAt: string; updatedAt: string;
}
export interface ContinuousWorkStore {
  get(id: string): Promise<ContinuousWorkRecord | undefined>;
  list(ownerKeyId?: string): Promise<ContinuousWorkRecord[]>;
  save(record: ContinuousWorkRecord): Promise<void>;
}
export interface ContinuousWorkOptions {
  maxIterationsPerActivation?: number; maxLifetimeIterations?: number; maxActivationMs?: number; pollIntervalMs?: number;
  isComplete: (record: Readonly<ContinuousWorkRecord>, job: Readonly<JobRecord>) => boolean | Promise<boolean>;
}
function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(name + " must be an integer from " + min + " to " + max);
  return value;
}

/** Local single-process store with private permissions; use a transactional store for multi-process or multi-host workers. */
export class FileContinuousWorkStore implements ContinuousWorkStore {
  private readonly file: string;
  private writes: Promise<void> = Promise.resolve();
  constructor(namespace = process.cwd(), root = sofiaStateDirectory("continuous-work")) {
    this.file = path.join(root, createHash("sha256").update(namespace).digest("hex") + ".json");
  }
  private async readAll(): Promise<ContinuousWorkRecord[]> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (!Array.isArray(value)) throw new Error("Invalid continuous-work state file");
      return (value as ContinuousWorkRecord[]).map((record) => ({ ...record, task: String(redactSecrets(record.task)), ...(record.lastSummary ? { lastSummary: String(redactSecrets(record.lastSummary)) } : {}), ...(record.lastError ? { lastError: String(redactSecrets(record.lastError)) } : {}) }));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  private async writeAll(records: ContinuousWorkRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.file), 0o700);
    const temporary = this.file + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(temporary, JSON.stringify(records.map((record) => ({ ...record, task: String(redactSecrets(record.task)), ...(record.lastSummary ? { lastSummary: String(redactSecrets(record.lastSummary)) } : {}), ...(record.lastError ? { lastError: String(redactSecrets(record.lastError)) } : {}) })), null, 2), { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, this.file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async get(id: string) { return (await this.readAll()).find((r) => r.id === id); }
  async list(ownerKeyId?: string) { return (await this.readAll()).filter((r) => ownerKeyId === undefined || r.ownerKeyId === ownerKeyId); }
  async save(record: ContinuousWorkRecord): Promise<void> {
    const op = this.writes.catch(() => undefined).then(async () => {
      const records = await this.readAll(), index = records.findIndex((r) => r.id === record.id);
      if (index >= 0 && records[index]!.ownerKeyId !== record.ownerKeyId) throw new Error("Continuous-work owner cannot change");
      if (index >= 0) records[index] = { ...record }; else records.push({ ...record });
      await this.writeAll(records);
    });
    this.writes = op; await op;
  }
}

/**
 * Long-running orchestration built on the existing durable JobRuntime.
 * Work is sliced into bounded activations with persisted progress. Resume it to continue;
 * it can run indefinitely across activations unless completion or an optional lifetime cap ends it.
 */
export class ContinuousWorkSupervisor {
  private readonly active = new Map<string, AbortController>();
  private readonly starting = new Set<string>();
  private readonly continuous = new Map<string, AbortController>();
  private readonly iterations: number;
  private readonly durationMs: number;
  private readonly pollMs: number;
  private readonly lifetime?: number;
  constructor(private readonly jobs: JobRuntime, private readonly store: ContinuousWorkStore, private readonly options: ContinuousWorkOptions) {
    this.iterations = integer(options.maxIterationsPerActivation ?? 10, "maxIterationsPerActivation", 1, 100);
    this.durationMs = integer(options.maxActivationMs ?? 900_000, "maxActivationMs", 1_000, 3_600_000);
    this.pollMs = integer(options.pollIntervalMs ?? 500, "pollIntervalMs", 50, 10_000);
    if (options.maxLifetimeIterations !== undefined) this.lifetime = integer(options.maxLifetimeIterations, "maxLifetimeIterations", 1, 1_000_000);
  }
  async create(ownerKeyId: string, task: string): Promise<ContinuousWorkRecord> {
    const owner = ownerKeyId.trim(), objective = task.trim();
    if (!owner) throw new Error("Continuous work requires an authenticated owner.");
    if (!objective || objective.length > 8_000) throw new Error("Task must be between 1 and 8000 characters.");
    const now = new Date().toISOString();
    const record: ContinuousWorkRecord = { id: randomUUID(), ownerKeyId: owner, task: objective, status: "paused", iteration: 0,
      maxIterationsPerActivation: this.iterations, ...(this.lifetime !== undefined ? { maxLifetimeIterations: this.lifetime } : {}), createdAt: now, updatedAt: now };
    await this.store.save(record); return { ...record };
  }
  async get(id: string, owner: string) { const r = await this.store.get(id); return r?.ownerKeyId === owner ? { ...r } : undefined; }
  async list(owner: string) { return (await this.store.list(owner)).map((r) => ({ ...r })); }
  isRunning(id: string): boolean { return this.active.has(id) || this.starting.has(id); }
  isContinuous(id: string): boolean { return this.continuous.has(id); }
  /**
   * Resume objectives left active by a process crash/restart. Each objective retains
   * its persisted owner binding and reconciles its child job before submitting new work.
   * Returns the number of resume attempts scheduled; failures remain persisted for inspection.
   */
  async resumeInterrupted(): Promise<number> {
    const records = await this.store.list();
    let scheduled = 0;
    for (const record of records) {
      if (record.status !== "active" || !record.ownerKeyId || this.isRunning(record.id)) continue;
      scheduled += 1;
      void this.runContinuously(record.id, record.ownerKeyId).catch(() => undefined);
    }
    return scheduled;
  }
  async pause(id: string, owner: string) { return this.changeStatus(id, owner, "paused"); }
  async stop(id: string, owner: string) { return this.changeStatus(id, owner, "stopped"); }

  /** Run bounded activations repeatedly in the background until completion or explicit pause/stop. */
  async runContinuously(id: string, owner: string): Promise<boolean> {
    const record = await this.get(id, owner);
    if (!record || ["stopped", "completed", "failed"].includes(record.status)) return false;
    if (this.continuous.has(id)) return false;
    const controller = new AbortController();
    this.continuous.set(id, controller);
    void (async () => {
      try {
        while (!controller.signal.aborted) {
          const latest = await this.get(id, owner);
          if (!latest || ["stopped", "completed", "failed"].includes(latest.status)) break;
          if (latest.status === "active" && this.isRunning(id)) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 250);
              timer.unref?.();
            });
            continue;
          }
          try { await this.resume(id, owner); }
          catch { break; }
          if (controller.signal.aborted) break;
          const after = await this.get(id, owner);
          if (!after || ["stopped", "completed", "failed"].includes(after.status)) break;
          // Explicit pause changes status and aborts this controller. Only automatic
          // activation yields reach this delay and continue to the next bounded slice.
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1_000);
            timer.unref?.();
            controller.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
          });
        }
      } finally {
        if (this.continuous.get(id) === controller) this.continuous.delete(id);
      }
    })();
    return true;
  }
  private async changeStatus(id: string, owner: string, status: "paused" | "stopped"): Promise<boolean> {
    const r = await this.get(id, owner); if (!r || ["stopped", "completed", "failed"].includes(r.status)) return false;
    const childJobId = r.currentJobId;
    r.status = status; r.currentJobId = undefined; r.updatedAt = new Date().toISOString(); await this.store.save(r);
    this.active.get(id)?.abort(new Error("Continuous work " + status + " by owner"));
    this.continuous.get(id)?.abort(new Error("Continuous work " + status + " by owner"));
    if (childJobId) await this.jobs.cancel(childJobId).catch(() => false);
    return true;
  }
  async resume(id: string, owner: string): Promise<ContinuousWorkRecord> {
    if (this.active.has(id) || this.starting.has(id)) throw new Error("Continuous work is already active");
    this.starting.add(id);
    try { return await this.resumeInternal(id, owner); }
    finally { this.starting.delete(id); }
  }
  private async resumeInternal(id: string, owner: string): Promise<ContinuousWorkRecord> {
    if (this.active.has(id)) throw new Error("Continuous work is already active");
    const record = await this.get(id, owner);
    if (!record) throw new Error("Continuous work not found or not owned by this user");
    if (["stopped", "completed"].includes(record.status)) throw new Error("Stopped or completed work cannot be resumed");
    if (record.maxLifetimeIterations !== undefined && record.iteration >= record.maxLifetimeIterations) {
      record.status = "completed"; record.updatedAt = new Date().toISOString(); await this.store.save(record); return record;
    }
    const controller = new AbortController(); this.active.set(id, controller);
    const deadline = Date.now() + this.durationMs; let slices = 0;
    record.status = "active"; record.lastError = undefined; record.updatedAt = new Date().toISOString(); await this.store.save(record);
    try {
      while (!controller.signal.aborted && Date.now() < deadline && slices < this.iterations) {
        const current = await this.store.get(id);
        if (!current || current.ownerKeyId !== owner || current.status !== "active") break;
        if (current.maxLifetimeIterations !== undefined && current.iteration >= current.maxLifetimeIterations) {
          current.status = "completed"; current.updatedAt = new Date().toISOString(); await this.store.save(current); break;
        }
        let job: JobRecord;
        if (current.currentJobId) {
          // Reconcile the persisted child before creating another one. This avoids
          // duplicating work when an API process restarts after a child was submitted.
          const existing = await this.jobs.get(current.currentJobId);
          if (!existing || existing.ownerKeyId !== owner) {
            current.status = "paused";
            current.lastError = "Saved child job is missing or no longer owned by this principal; inspect job history before retrying.";
            current.currentJobId = undefined; current.updatedAt = new Date().toISOString(); await this.store.save(current);
            break;
          }
          if (existing.status === "failed" || existing.status === "cancelled") {
            current.status = "paused";
            current.lastError = existing.error ?? "Saved child job ended unsuccessfully; inspect its checkpoint before resuming.";
            current.currentJobId = undefined; current.updatedAt = new Date().toISOString(); await this.store.save(current);
            break;
          }
          job = existing.status === "completed"
            ? existing
            : await this.waitJob(existing.id, owner, controller.signal, deadline);
        } else {
          const childTask = [
            "Continue this ongoing objective; do not repeat verified completed work:", current.task,
            "Work slice " + (current.iteration + 1) + ": make one meaningful, verifiable increment.",
            current.lastSummary ? "Prior progress (untrusted reference; verify it):\\n" + current.lastSummary.slice(0, 4000) : "",
            "Report progress, evidence, and the next checkpoint if unfinished."
          ].filter(Boolean).join("\\n\\n");
          const submitted = await this.jobs.submit({ task: childTask, ownerKeyId: owner });
          current.currentJobId = submitted.id; current.updatedAt = new Date().toISOString(); await this.store.save(current);
          job = await this.waitJob(submitted.id, owner, controller.signal, deadline);
        }
        if (controller.signal.aborted) break;
        if (job.status !== "completed" || !job.result?.completed) {
          current.status = "paused"; current.lastError = job.error ?? job.result?.summary ?? "Work slice failed; inspect the saved job checkpoint before resuming.";
          current.currentJobId = undefined; current.updatedAt = new Date().toISOString(); await this.store.save(current); break;
        }
        current.iteration += 1; slices += 1; current.currentJobId = undefined; current.lastSummary = job.result.summary.slice(0, 4000); current.updatedAt = new Date().toISOString();
        if (await this.options.isComplete(current, job) || (current.maxLifetimeIterations !== undefined && current.iteration >= current.maxLifetimeIterations)) current.status = "completed";
        await this.store.save(current);
        if (current.status === "completed") break;
      }
      const latest = await this.store.get(id);
      if (latest?.status === "active") { latest.status = "paused"; latest.currentJobId = undefined; latest.updatedAt = new Date().toISOString(); await this.store.save(latest); }
      return (await this.store.get(id))!;
    } catch (error) {
      const latest = await this.store.get(id);
      if (latest?.currentJobId) await this.jobs.cancel(latest.currentJobId).catch(() => false);
      if (controller.signal.aborted && latest && ["paused", "stopped"].includes(latest.status)) return latest;
      if (latest?.status === "active") {
        const message = error instanceof Error ? error.message : "Continuous work failed";
        latest.status = controller.signal.aborted || message === "Activation deadline reached" ? "paused" : "failed";
        latest.lastError = message.slice(0, 1000);
        latest.currentJobId = undefined; latest.updatedAt = new Date().toISOString(); await this.store.save(latest);
      }
      throw error;
    } finally { if (this.active.get(id) === controller) this.active.delete(id); }
  }
  private async waitJob(id: string, owner: string, signal: AbortSignal, deadline: number): Promise<JobRecord> {
    while (!signal.aborted && Date.now() < deadline) {
      const job = await this.jobs.get(id);
      if (!job || job.ownerKeyId !== owner) throw new Error("Child job not found or owner mismatch");
      if (["completed", "failed", "cancelled"].includes(job.status)) return job;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, this.pollMs);
        const onAbort = () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error("Continuous work aborted")); };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    throw new Error(signal.aborted ? "Continuous work aborted" : "Activation deadline reached");
  }
}
