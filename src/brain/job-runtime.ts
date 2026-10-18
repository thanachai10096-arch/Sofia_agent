import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BrainRunInput, SofiaBrain } from "./executor.js";
import type { BrainRunSnapshot } from "./run-state.js";
import type { RunStore } from "./run-store.js";
import { sofiaStateDirectory } from "../platform/state-directory.js";
import { redactSecrets } from "../security/guard.js";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export interface JobRecord {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  task: string;
  ownerKeyId?: string;
  leaseOwnerToken?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  snapshot?: BrainRunSnapshot;
  result?: Awaited<ReturnType<SofiaBrain["run"]>>;
  error?: string;
}
async function renameStateFile(source: string, destination: string): Promise<void> {
  // Windows can transiently deny replacement while another local process has a
  // short-lived read handle open. Keep the lock and retry only those transient
  // sharing violations; never delete the destination to force a non-atomic write.
  const attempts = process.platform === "win32" ? 50 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY") || attempt === attempts - 1) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}

function isJobCancelled(record: JobRecord): boolean { return record.status === "cancelled"; }

function redactJobRecord(record: JobRecord): JobRecord {
  return {
    ...record,
    // Preserve leaseOwnerToken and lease timestamps: these are runtime fencing
    // metadata, not user content, and redacting them would break worker claims.
    task: String(redactSecrets(record.task)),
    ...(record.snapshot ? { snapshot: redactSecrets(record.snapshot) as BrainRunSnapshot } : {}),
    ...(record.result ? { result: redactSecrets(record.result) as JobRecord["result"] } : {}),
    ...(record.error ? { error: String(redactSecrets(record.error)) } : {}),
  };
}


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
        let foreignHost = false;
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
          } else if (typeof lock.hostname === "string" && lock.hostname !== os.hostname()) {
            // Age cannot prove that a worker on another host is dead. Fail closed;
            // use a transactional shared store for multi-host coordination.
            foreignHost = true;
          } else if (age > 120_000) {
            stale = true;
          }
          if (!observedToken && age > 120_000 && !foreignHost) stale = true;
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

        if (foreignHost) {
          throw new Error("File-backed job state lock belongs to another host; use a transactional shared store for multi-host workers");
        }

        if (stale) {
          // Serialize stale-lock reclamation itself. A token recheck alone is not
          // atomic with unlink: two reclaimers could both observe the old token,
          // then the slower one could delete a replacement owner's lock.
          const reclaimFile = this.lockFile + ".reclaim";
          let reclaimHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
          const reclaimToken = randomUUID();
          try {
            reclaimHandle = await fs.open(reclaimFile, "wx", 0o600);
            await reclaimHandle.writeFile(JSON.stringify({
              token: reclaimToken,
              pid: process.pid,
              hostname: os.hostname(),
              createdAt: Date.now(),
            }), "utf8");
            await reclaimHandle.close();
            reclaimHandle = undefined;
          } catch (reclaimError) {
            const createdReclaimFile = reclaimHandle !== undefined;
            await reclaimHandle?.close().catch(() => undefined);
            if (createdReclaimFile) await fs.rm(reclaimFile, { force: true }).catch(() => undefined);
            if ((reclaimError as NodeJS.ErrnoException).code === "EEXIST") {
              if (Date.now() >= deadline) throw new Error("Timed out waiting for durable job-state stale-lock reclamation");
              await new Promise<void>((resolve) => setTimeout(resolve, 20));
              continue;
            }
            throw reclaimError;
          }

          try {
            // Re-evaluate the current lock while holding the single reclaimer
            // slot. Do not trust the stale observation made before acquiring it.
            try {
              const latest = JSON.parse(await fs.readFile(this.lockFile, "utf8")) as {
                token?: unknown; pid?: unknown; hostname?: unknown; createdAt?: unknown;
              };
              const latestToken = typeof latest.token === "string" ? latest.token : undefined;
              const latestAge = Date.now() - (typeof latest.createdAt === "number" ? latest.createdAt : 0);
              let latestStale = false;
              if (latest.hostname === os.hostname() && Number.isSafeInteger(latest.pid) && Number(latest.pid) > 0) {
                try {
                  process.kill(Number(latest.pid), 0);
                } catch (probeError) {
                  latestStale = (probeError as NodeJS.ErrnoException).code === "ESRCH";
                }
              } else if (typeof latest.hostname === "string" && latest.hostname !== os.hostname()) {
                // Never reclaim a lock owned by a different host based on age alone.
                latestStale = false;
              } else if (latestAge > 120_000) {
                latestStale = true;
              }
              if (!latestToken && latestAge > 120_000 && !(typeof latest.hostname === "string" && latest.hostname !== os.hostname())) latestStale = true;
              if (latestStale && latestToken === observedToken) {
                await fs.rm(this.lockFile, { force: true });
              }
            } catch (recheckError) {
              if ((recheckError as NodeJS.ErrnoException).code === "ENOENT") {
                // Another process already removed the stale lock.
              } else {
                // Only reclaim malformed locks after rechecking their current age
                // while all cooperating reclaimers are serialized.
                let lockStat;
                try {
                  lockStat = await fs.stat(this.lockFile);
                } catch (statError) {
                  if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
                  throw statError;
                }
                if (Date.now() - lockStat.mtimeMs > 120_000) {
                  await fs.rm(this.lockFile, { force: true });
                }
              }
            }
          } finally {
            try {
              const currentReclaimer = JSON.parse(await fs.readFile(reclaimFile, "utf8")) as { token?: unknown };
              if (currentReclaimer.token === reclaimToken) await fs.rm(reclaimFile, { force: true });
            } catch (cleanupError) {
              if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
            }
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

  private async write(records: JobRecord[]): Promise<void> {
    const temporary = this.file + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(temporary, JSON.stringify(records.map(redactJobRecord), null, 2), { encoding: "utf8", mode: 0o600 });
      await renameStateFile(temporary, this.file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async claim(id: string, ownerToken: string, leaseMs: number): Promise<JobRecord | undefined> {
    return this.withFileLock(async () => {
      const records = await this.read();
      const record = records.find((item) => item.id === id);
      if (!record || record.status === "completed" || record.status === "cancelled") return undefined;
      const now = Date.now();
      const expires = record.leaseExpiresAt ? Date.parse(record.leaseExpiresAt) : 0;
      if (record.status === "running" && Number.isFinite(expires) && expires > now) return undefined;
      record.status = "running";
      record.leaseOwnerToken = ownerToken;
      record.heartbeatAt = new Date(now).toISOString();
      record.leaseExpiresAt = new Date(now + leaseMs).toISOString();
      record.updatedAt = new Date(now).toISOString();
      record.error = undefined;
      await this.write(records);
      return { ...record };
    });
  }

  async heartbeat(id: string, ownerToken: string, leaseMs: number): Promise<boolean> {
    return this.withFileLock(async () => {
      const records = await this.read();
      const record = records.find((item) => item.id === id);
      if (!record || record.status !== "running" || record.leaseOwnerToken !== ownerToken) return false;
      const currentExpiry = record.leaseExpiresAt ? Date.parse(record.leaseExpiresAt) : 0;
      if (!Number.isFinite(currentExpiry) || currentExpiry <= Date.now()) return false;
      const now = Date.now();
      record.heartbeatAt = new Date(now).toISOString();
      record.leaseExpiresAt = new Date(now + leaseMs).toISOString();
      record.updatedAt = new Date(now).toISOString();
      await this.write(records);
      return true;
    });
  }

  async markInterruptedIfExpired(id: string): Promise<JobRecord | undefined> {
    return this.withFileLock(async () => {
      const records = await this.read();
      const record = records.find((item) => item.id === id);
      if (!record || record.status !== "running") return record ? { ...record } : undefined;
      const expires = record.leaseExpiresAt ? Date.parse(record.leaseExpiresAt) : 0;
      if (Number.isFinite(expires) && expires > Date.now()) return { ...record };
      record.status = "failed";
      record.error = record.snapshot
        ? "Job lease expired after a worker stopped heartbeating; resume it from the saved snapshot."
        : "Job lease expired before a resumable snapshot was saved.";
      record.leaseOwnerToken = undefined;
      record.leaseExpiresAt = undefined;
      record.updatedAt = new Date().toISOString();
      await this.write(records);
      return { ...record };
    });
  }

  async cancel(id: string): Promise<JobRecord | undefined> {
    return this.withFileLock(async () => {
      const records = await this.read();
      const record = records.find((item) => item.id === id);
      if (!record || record.status === "completed" || record.status === "failed" || record.status === "cancelled") {
        return undefined;
      }
      record.status = "cancelled";
      record.error ??= "Job cancelled by caller.";
      record.updatedAt = new Date().toISOString();
      await this.write(records);
      return { ...record };
    });
  }

  private async read(): Promise<JobRecord[]> {
    try {
      const records = JSON.parse(await fs.readFile(this.file, "utf8")) as JobRecord[];
      return records.map(redactJobRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async save(record: JobRecord): Promise<boolean> {
    const operation = this.writes.then(() => this.withFileLock(async () => {
      const records = await this.read();
      const index = records.findIndex((item) => item.id === record.id);
      if (index >= 0) {
        const current = records[index]!;
        if (current.leaseOwnerToken !== record.leaseOwnerToken) return false;
        if (current.status === "cancelled" && record.status !== "cancelled") return false;
        records[index] = {
          ...record,
          ...(record.status === "running" && current.status === "running"
            ? { leaseExpiresAt: current.leaseExpiresAt, heartbeatAt: current.heartbeatAt }
            : {}),
        };
      } else {
        records.push({ ...record });
      }
      await this.write(records);
      return true;
    }));
    this.writes = operation.then(() => undefined, () => undefined);
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
  private readonly starting = new Set<string>();
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
    if (record.status === "running" && !this.controllers.has(record.id)) {
      const expires = record.leaseExpiresAt ? Date.parse(record.leaseExpiresAt) : 0;
      if (!Number.isFinite(expires) || expires <= Date.now()) {
        const recovered = await this.state.markInterruptedIfExpired(record.id);
        if (recovered) Object.assign(record, recovered);
      }
    }
    return record;
  }

  async get(id: string): Promise<JobRecord | undefined> {
    const existing = this.jobs.get(id);
    // Keep the canonical record stable while a local worker is atomically claiming it.
    // After startup, non-local reads refresh from disk to observe cancellation/expiry.
    if (existing && (this.controllers.has(id) || this.starting.has(id))) return { ...existing };

    const stored = await this.state.get(id);
    if (!stored) return existing ? { ...existing } : undefined;
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
      if (this.controllers.has(persisted.id) || this.starting.has(persisted.id)) continue;
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
    const persisted = await this.state.cancel(id);
    if (!persisted || persisted.status !== "cancelled") return false;
    const record = this.jobs.get(id);
    if (record) Object.assign(record, persisted);
    controller?.abort(new Error("Job cancelled by caller"));
    return true;
  }

  private async execute(
    record: JobRecord,
    input: Omit<BrainRunInput, "signal" | "resume">,
    externalSignal?: AbortSignal,
    resume?: BrainRunSnapshot,
  ): Promise<void> {
    if (record.status === "cancelled" || record.status === "completed") return;
    const leaseToken = randomUUID();
    const leaseMs = 15_000;
    this.starting.add(record.id);
    let claimed: JobRecord | undefined;
    try {
      claimed = await this.state.claim(record.id, leaseToken, leaseMs);
    } finally {
      this.starting.delete(record.id);
    }
    if (!claimed) {
      const latest = await this.state.get(record.id);
      if (latest) Object.assign(record, latest);
      return;
    }
    Object.assign(record, claimed);

    // Register cancellation before the first await so cancel() cannot miss startup.
    const controller = new AbortController();
    this.controllers.set(record.id, controller);
    const heartbeat = setInterval(() => {
      void this.state.heartbeat(record.id, leaseToken, leaseMs).then((ok) => {
        if (!ok) controller.abort(new Error("Job execution lease was lost"));
      }).catch(() => {
        // A transient store error is not proof of lease loss; a later heartbeat retries.
      });
    }, Math.floor(leaseMs / 3));
    heartbeat.unref?.();
    let onExternalAbort: (() => void) | undefined;
    if (externalSignal) {
      onExternalAbort = () => controller.abort(externalSignal.reason);
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const onSnapshot = async (snapshot: BrainRunSnapshot): Promise<void> => {
      // The separate RunStore persists snapshots independently of the redacted job
      // record. Sanitize before either persistence path so credentials cannot bypass
      // redaction through the checkpoint store and reappear after a restart.
      const safeSnapshot = redactSecrets(snapshot) as BrainRunSnapshot;
      record.snapshot = safeSnapshot;
      record.updatedAt = new Date().toISOString();
      try {
        await this.runStore?.save(safeSnapshot);
      } catch {
        // The job record also embeds its snapshot. Persist that fallback even when
        // the dedicated snapshot store is temporarily unavailable.
      }
      const saved = await this.state.save(record);
      if (!saved) controller.abort(new Error("Job execution lease was lost or cancelled"));
    };

    try {
      const latest = await this.state.get(record.id);
      if (!latest || latest.status !== "running" || latest.leaseOwnerToken !== leaseToken) {
        if (latest) Object.assign(record, latest);
        controller.abort(new Error("Job execution lease was lost or cancelled before dispatch"));
        return;
      }
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
      clearInterval(heartbeat);
      if (externalSignal && onExternalAbort) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
      if (this.controllers.get(record.id) === controller) this.controllers.delete(record.id);
    }
  }

}
