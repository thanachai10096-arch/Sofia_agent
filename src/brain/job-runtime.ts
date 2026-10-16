import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { BrainRunInput, SofiaBrain } from "./executor.js";
import type { BrainRunSnapshot } from "./run-state.js";
import type { RunStore } from "./run-store.js";
import { sofiaStateDirectory } from "../platform/state-directory.js";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export interface JobRecord {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  task: string;
  ownerKeyId?: string;
  snapshot?: BrainRunSnapshot;
  result?: Awaited<ReturnType<SofiaBrain["run"]>>;
  error?: string;
}
function isJobCancelled(record: JobRecord): boolean { return record.status === "cancelled"; }

export interface JobRuntime {
  submit(input: Omit<BrainRunInput, "signal" | "resume"> & { ownerKeyId?: string }): Promise<JobRecord>;
  get(id: string): Promise<JobRecord | undefined>;
  resume(id: string, signal?: AbortSignal): Promise<JobRecord>;
  cancel(id: string): Promise<boolean>;
  list(): Promise<JobRecord[]>;
}

export interface JobStateStore {
  save(record: JobRecord): Promise<void>;
  list(): Promise<JobRecord[]>;
  get(id: string): Promise<JobRecord | undefined>;
}

// FileJobStateStore instances created by separate runtimes in the same process
// must share one write queue for a namespace. A per-instance queue allows two
// read-modify-write operations to race and silently lose an admitted job.
const fileJobStateWrites = new Map<string, Promise<void>>();

class FileJobStateStore implements JobStateStore {
  private readonly file: string;

  constructor(namespace: string, root = sofiaStateDirectory("jobs")) {
    this.file = path.join(root, createHash("sha256").update(namespace).digest("hex") + ".json");
  }

  private async read(): Promise<JobRecord[]> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as JobRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async save(record: JobRecord): Promise<void> {
    const previous = fileJobStateWrites.get(this.file) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const records = await this.read();
      const index = records.findIndex((item) => item.id === record.id);
      const durable = { ...record };
      if (index >= 0) records[index] = durable;
      else records.push(durable);

      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await fs.chmod(path.dirname(this.file), 0o700);
      // A unique temporary file prevents overlapping writes from clobbering each other.
      const temporary = this.file + "." + randomUUID() + ".tmp";
      try {
        await fs.writeFile(temporary, JSON.stringify(records, null, 2), { encoding: "utf8", mode: 0o600 });
        await fs.rename(temporary, this.file);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    });
    const queued = operation.catch(() => undefined);
    fileJobStateWrites.set(this.file, queued);
    try {
      await operation;
    } finally {
      if (fileJobStateWrites.get(this.file) === queued) fileJobStateWrites.delete(this.file);
    }
  }

  async list(): Promise<JobRecord[]> {
    return this.read();
  }

  async get(id: string): Promise<JobRecord | undefined> {
    return (await this.read()).find((record) => record.id === id);
  }
}

export class DurableJobRuntime implements JobRuntime {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly resuming = new Set<string>();
  private readonly state: JobStateStore;

  constructor(
    private readonly brainFactory: (options: {
      signal?: AbortSignal;
      maxSteps?: number;
      onRunSnapshot?: (snapshot: BrainRunSnapshot) => void | Promise<void>;
    }) => SofiaBrain,
    private readonly runStore?: RunStore,
    namespace = process.cwd(),
    stateStore?: JobStateStore,
  ) {
    this.state = stateStore ?? new FileJobStateStore(namespace);
  }

  async submit(input: Omit<BrainRunInput, "signal" | "resume"> & { ownerKeyId?: string }): Promise<JobRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: JobRecord = {
      id, status: "queued", createdAt: now, updatedAt: now, task: input.task,
      ...(input.ownerKeyId ? { ownerKeyId: input.ownerKeyId } : {}),
    };
    // Admission is durable before the job becomes visible in memory or execution
    // starts. A failed write must not leave a ghost job that can be polled/resumed.
    await this.state.save(record);
    this.jobs.set(id, record);
    void this.execute(record, input);
    return { ...record };
  }

  private async recoverInterrupted(record: JobRecord): Promise<JobRecord> {
    if ((record.status === "running" || record.status === "queued") && !this.controllers.has(record.id)) {
      record.status = "failed";
      record.error = record.snapshot
        ? "Job was interrupted by a process restart; resume it from the saved snapshot."
        : "Job was interrupted before a resumable snapshot was saved.";
      record.updatedAt = new Date().toISOString();
      try {
        await this.state.save(record);
      } catch {
        // Recovery status remains useful in this process even if the disk is read-only.
      }
    }
    return record;
  }

  async get(id: string): Promise<JobRecord | undefined> {
    const existing = this.jobs.get(id);
    if (existing) return { ...existing };

    const stored = await this.state.get(id);
    if (!stored) return undefined;
    const snapshot = stored.snapshot?.runId && this.runStore
      ? await this.runStore.load(stored.snapshot.runId)
      : undefined;
    const hydrated = { ...stored, ...(snapshot ? { snapshot } : {}) };
    await this.recoverInterrupted(hydrated);
    this.jobs.set(id, hydrated);
    return { ...hydrated };
  }

  async list(): Promise<JobRecord[]> {
    const stored = await this.state.list();
    for (const persisted of stored) {
      // Keep live in-memory records authoritative over older disk snapshots.
      if (this.jobs.has(persisted.id)) continue;
      const snapshot = persisted.snapshot?.runId && this.runStore
        ? await this.runStore.load(persisted.snapshot.runId)
        : undefined;
      const hydrated = { ...persisted, ...(snapshot ? { snapshot } : {}) };
      await this.recoverInterrupted(hydrated);
      this.jobs.set(hydrated.id, hydrated);
    }
    return [...this.jobs.values()].map((record) => ({ ...record }));
  }

  async resume(id: string, signal?: AbortSignal): Promise<JobRecord> {
    // Reserve the resume slot before the first await. Otherwise two callers can both
    // pass the guard while get() is pending and race to resume the same checkpoint.
    if (this.resuming.has(id)) throw new Error("Job is already being resumed");
    this.resuming.add(id);
    try {
      const fetched = await this.get(id);
      if (!fetched) throw new Error("Unknown job");
      // get() returns a defensive copy; mutations must target the canonical live record.
      const record = this.jobs.get(id) ?? fetched;
      if (record.status === "completed") return { ...record };
      if (record.status === "cancelled") throw new Error("Cancelled jobs cannot be resumed");
      if (!record.snapshot) throw new Error("Job has no resumable snapshot");
      // A terminal status may be persisted just before the previous worker's finally block
      // removes its controller. Only the canonical status determines whether resume is blocked.
      if (record.status === "running") throw new Error("Job is already running");
      await this.execute(record, { task: record.task, acceptanceCriteria: record.snapshot.acceptanceCriteria }, signal, record.snapshot);
      return { ...record };
    } finally {
      this.resuming.delete(id);
    }
  }

  async cancel(id: string): Promise<boolean> {
    const controller = this.controllers.get(id);
    const fetched = this.jobs.get(id) ? { ...this.jobs.get(id)! } : await this.get(id);
    if (!fetched) return false;
    const record = this.jobs.get(id) ?? fetched;
    if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") return false;

    // Keep the in-memory record authoritative even when cancellation races startup.
    record.status = "cancelled";
    record.error ??= "Job cancelled by caller.";
    record.updatedAt = new Date().toISOString();
    // Cancellation is a live control action: abort first so a storage outage cannot
    // leave execution running after the caller requested cancellation.
    controller?.abort(new Error("Job cancelled by caller"));
    try {
      await this.state.save(record);
    } catch {
      // Keep cancellation effective in memory; durable status may need reconciliation.
    }
    return true;
  }

  private async execute(
    record: JobRecord,
    input: Omit<BrainRunInput, "signal" | "resume">,
    externalSignal?: AbortSignal,
    resume?: BrainRunSnapshot,
  ): Promise<void> {
    if (record.status === "running" || record.status === "cancelled") return;
    record.status = "running";
    record.updatedAt = new Date().toISOString();

    // Register cancellation before the first await so cancel() cannot miss startup.
    const controller = new AbortController();
    this.controllers.set(record.id, controller);
    let onExternalAbort: (() => void) | undefined;
    if (externalSignal) {
      onExternalAbort = () => controller.abort(externalSignal.reason);
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const onSnapshot = async (snapshot: BrainRunSnapshot): Promise<void> => {
      record.snapshot = snapshot;
      record.updatedAt = new Date().toISOString();
      try {
        await this.runStore?.save(snapshot);
      } catch {
        // The job record also embeds its snapshot. Persist that fallback even when
        // the dedicated snapshot store is temporarily unavailable.
      }
      await this.state.save(record);
    };

    try {
      await this.state.save(record);
      if (controller.signal.aborted || isJobCancelled(record)) {
        if (!isJobCancelled(record)) {
          record.status = "cancelled";
          record.error ??= "Job cancelled by caller.";
          record.updatedAt = new Date().toISOString();
          await this.state.save(record);
        }
        return;
      }

      const brain = this.brainFactory({ signal: controller.signal, onRunSnapshot: onSnapshot });
      const result = await brain.run({
        ...input,
        ...(record.ownerKeyId ? { principalId: record.ownerKeyId } : {}),
        signal: controller.signal,
        resume,
      });
      const resultState: string = result.state;
      if (controller.signal.aborted || resultState === "cancelled" || isJobCancelled(record)) {
        // Cancellation is terminal: discard any result that arrives after abort.
        record.status = "cancelled";
        record.error ??= "Job cancelled.";
        record.result = undefined;
      } else {
        record.result = result;
        record.status = result.completed ? "completed" : "failed";
      }
      record.updatedAt = new Date().toISOString();
      try {
        await this.state.save(record);
      } catch {
        // Execution succeeded; keep its truthful in-memory result/status if the
        // terminal snapshot cannot be persisted. Durability is degraded, not execution.
      }
    } catch (error) {
      if (record.status !== "cancelled") {
        record.error = error instanceof Error ? error.message : String(error);
        record.status = controller.signal.aborted ? "cancelled" : "failed";
        record.updatedAt = new Date().toISOString();
      }
      try {
        await this.state.save(record);
      } catch {
        // Keep the in-memory terminal failure, but do not leak a rejected detached
        // execution promise when the state store is unavailable.
      }
    } finally {
      if (externalSignal && onExternalAbort) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
      // An older run must not remove a controller installed by a fast resume.
      if (this.controllers.get(record.id) === controller) this.controllers.delete(record.id);
    }
  }

}
