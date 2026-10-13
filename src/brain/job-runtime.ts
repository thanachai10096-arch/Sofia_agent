import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
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

class FileJobStateStore {
  private readonly file: string;
  private readonly lockFile: string;
  private writes: Promise<void> = Promise.resolve();

  constructor(namespace: string, root = sofiaStateDirectory("jobs")) {
    this.file = path.join(root, createHash("sha256").update(namespace).digest("hex") + ".json");
    this.lockFile = this.file + ".lock";
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    const owner = { token, pid: process.pid, hostname: os.hostname(), createdAt: Date.now() };
    const deadline = Date.now() + 10_000;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;

    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.file), 0o700);

    while (!handle) {
      try {
        handle = await fs.open(this.lockFile, "wx", 0o600);
        await handle.writeFile(JSON.stringify(owner), "utf8");
        await handle.close();
        handle = undefined;
        break;
      } catch (error) {
        const createdLock = handle !== undefined;
        await handle?.close().catch(() => undefined);
        handle = undefined;
        if (createdLock) {
          // If writing the owner record fails after exclusive creation, do not
          // leave a malformed lock behind to block every future writer.
          await fs.rm(this.lockFile, { force: true }).catch(() => undefined);
          throw error;
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

        let stale = false;
        let observedToken: string | undefined;
        try {
          const lock = JSON.parse(await fs.readFile(this.lockFile, "utf8")) as {
            token?: unknown; pid?: unknown; hostname?: unknown; createdAt?: unknown;
          };
          observedToken = typeof lock.token === "string" ? lock.token : undefined;
          const age = Date.now() - (typeof lock.createdAt === "number" ? lock.createdAt : 0);
          if (lock.hostname === os.hostname() && Number.isSafeInteger(lock.pid) && Number(lock.pid) > 0) {
            try {
              process.kill(Number(lock.pid), 0);
            } catch (probeError) {
              stale = (probeError as NodeJS.ErrnoException).code === "ESRCH";
            }
          } else if (age > 120_000) {
            // Cross-host stale-lock recovery is best-effort; this file store is not a
            // distributed lock service and must not be used as one across machines.
            stale = true;
          }
          if (!observedToken && age > 120_000) stale = true;
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
          // A newly-created lock can be observed before its JSON payload is fully
          // written. Treat malformed/partial contents as busy until the file is old.
          try {
            const lockStat = await fs.stat(this.lockFile);
            stale = Date.now() - lockStat.mtimeMs > 120_000;
          } catch (statError) {
            if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw statError;
          }
        }

        if (stale) {
          try {
            // Recheck the owner token before unlinking so we do not remove a lock
            // that another process replaced after our first read.
            const latest = JSON.parse(await fs.readFile(this.lockFile, "utf8")) as { token?: unknown };
            if (latest.token === observedToken) await fs.rm(this.lockFile, { force: true });
          } catch (cleanupError) {
            if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
          }
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error("Timed out waiting for durable job-state file lock");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    }

    // The exclusive lock is now ours. Re-read under the lock before every
    // read-modify-write so concurrent Node.js workers cannot overwrite each
    // other's job records. The lock is intentionally limited to this local
    // file store; multi-host coordination requires a shared transactional store.
    try {
      const current = JSON.parse(await fs.readFile(this.lockFile, "utf8")) as { token?: unknown };
      if (current.token !== token) throw new Error("Lost durable job-state file lock");
      return await operation();
    } finally {
      try {
        const current = JSON.parse(await fs.readFile(this.lockFile, "utf8")) as { token?: unknown };
        if (current.token === token) await fs.rm(this.lockFile, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
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
    const operation = this.writes.then(() => this.withFileLock(async () => {
      const records = await this.read();
      const index = records.findIndex((item) => item.id === record.id);
      const durable = { ...record };
      if (index >= 0) records[index] = durable;
      else records.push(durable);

      // Unique temporary files plus the cross-process lock make the complete
      // read-modify-write transaction atomic with respect to cooperating workers.
      const temporary = this.file + "." + randomUUID() + ".tmp";
      try {
        await fs.writeFile(temporary, JSON.stringify(records, null, 2), { encoding: "utf8", mode: 0o600 });
        await fs.rename(temporary, this.file);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    }));
    this.writes = operation.catch(() => undefined);
    return operation;
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
  private readonly state: FileJobStateStore;

  constructor(
    private readonly brainFactory: (options: {
      signal?: AbortSignal;
      maxSteps?: number;
      onRunSnapshot?: (snapshot: BrainRunSnapshot) => void | Promise<void>;
    }) => SofiaBrain,
    private readonly runStore?: RunStore,
    namespace = process.cwd(),
  ) {
    this.state = new FileJobStateStore(namespace);
  }

  async submit(input: Omit<BrainRunInput, "signal" | "resume"> & { ownerKeyId?: string }): Promise<JobRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: JobRecord = {
      id, status: "queued", createdAt: now, updatedAt: now, task: input.task,
      ...(input.ownerKeyId ? { ownerKeyId: input.ownerKeyId } : {}),
    };
    this.jobs.set(id, record);
    await this.state.save(record);
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
      await this.state.save(record);
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
    await this.state.save(record);
    controller?.abort(new Error("Job cancelled by caller"));
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
      await this.state.save(record);
    } catch (error) {
      if (record.status !== "cancelled") {
        record.error = error instanceof Error ? error.message : String(error);
        record.status = controller.signal.aborted ? "cancelled" : "failed";
        record.updatedAt = new Date().toISOString();
      }
      await this.state.save(record);
    } finally {
      if (externalSignal && onExternalAbort) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
      // An older run must not remove a controller installed by a fast resume.
      if (this.controllers.get(record.id) === controller) this.controllers.delete(record.id);
    }
  }

}
