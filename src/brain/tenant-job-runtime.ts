import type { BrainRunInput } from "./executor.js";
import type { JobRecord, JobRuntime } from "./job-runtime.js";
import type { TenantDependencyRegistry } from "../platform/tenant-dependency-registry.js";

type TenantJobRuntimeFactory = (ownerKeyId: string) => JobRuntime | Promise<JobRuntime>;

/**
 * Routes durable jobs to one runtime per authenticated API owner.
 *
 * The host factory must bind each runtime to that owner's Brain/dependencies and
 * give it a physically separate durable namespace and RunStore. The router never
 * accepts an owner from a job payload except the server-derived ownerKeyId supplied
 * by the trusted API boundary.
 */
export class TenantJobRuntimeRouter implements JobRuntime {
  private readonly allowedOwners: Set<string>;
  private readonly runtimes = new Map<string, Promise<JobRuntime>>();
  private readonly runtimeOwners = new WeakMap<JobRuntime, string>();
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(ownerKeyIds: readonly string[], private readonly factory: TenantJobRuntimeFactory) {
    this.allowedOwners = new Set(ownerKeyIds);
    if (this.allowedOwners.size !== ownerKeyIds.length ||
        ownerKeyIds.some((owner) => !/^[a-f0-9]{32}$/u.test(owner))) {
      throw new Error("Tenant job runtime requires unique server-derived 32-character owner IDs.");
    }
  }

  private runtimeFor(ownerKeyId: string): Promise<JobRuntime> {
    if (this.closed) throw new Error("Tenant job runtime router is closed.");
    if (!this.allowedOwners.has(ownerKeyId)) throw new Error("Unknown job owner.");
    const existing = this.runtimes.get(ownerKeyId);
    if (existing) return existing;
    const pending = Promise.resolve().then(async () => {
      const runtime = await this.factory(ownerKeyId);
      const existingOwner = this.runtimeOwners.get(runtime);
      if (existingOwner && existingOwner !== ownerKeyId) {
        throw new Error("Tenant JobRuntime factory returned a shared runtime instance for multiple owners.");
      }
      this.runtimeOwners.set(runtime, ownerKeyId);
      return runtime;
    }).catch((error: unknown) => {
      this.runtimes.delete(ownerKeyId);
      throw error;
    });
    this.runtimes.set(ownerKeyId, pending);
    return pending;
  }

  async submit(input: Omit<BrainRunInput, "signal" | "resume"> & {
    ownerKeyId?: string;
    notificationChannelId?: string;
    sessionKey?: string;
    sessionTask?: string;
  }): Promise<JobRecord> {
    if (!input.ownerKeyId) throw new Error("A server-derived ownerKeyId is required for tenant job submission.");
    const runtime = await this.runtimeFor(input.ownerKeyId);
    const job = await runtime.submit(input);
    if (job.ownerKeyId !== input.ownerKeyId) {
      throw new Error("Tenant job runtime returned a job with a mismatched owner.");
    }
    return job;
  }

  async getForOwner(id: string, ownerKeyId: string): Promise<JobRecord | undefined> {
    const runtime = await this.runtimeFor(ownerKeyId);
    if (!runtime.getForOwner) return undefined;
    const record = await runtime.getForOwner(id, ownerKeyId);
    return record?.ownerKeyId === ownerKeyId ? record : undefined;
  }

  async resumeForOwner(id: string, ownerKeyId: string, signal?: AbortSignal): Promise<JobRecord> {
    const runtime = await this.runtimeFor(ownerKeyId);
    if (!runtime.resumeForOwner) throw new Error("Owner-scoped job resume is unavailable.");
    const record = await runtime.resumeForOwner(id, ownerKeyId, signal);
    if (record.ownerKeyId !== ownerKeyId) throw new Error("Tenant job runtime returned a mismatched owner during resume.");
    return record;
  }

  async cancelForOwner(id: string, ownerKeyId: string): Promise<boolean> {
    const runtime = await this.runtimeFor(ownerKeyId);
    if (!runtime.cancelForOwner) return false;
    return runtime.cancelForOwner(id, ownerKeyId);
  }

  async get(id: string): Promise<JobRecord | undefined> {
    // A notification/recovery lookup can happen before list() has hydrated
    // runtimes after restart. Search every configured owner runtime rather
    // than silently treating an uninitialized tenant's persisted job as absent.
    const pending = await Promise.all([...this.allowedOwners].map((owner) => this.runtimeFor(owner)));
    for (const runtime of pending) {
      const record = await runtime.get(id);
      if (record) return record;
    }
    return undefined;
  }

  async resume(_id: string, _signal?: AbortSignal): Promise<JobRecord> {
    throw new Error("Unscoped job resume is disabled by TenantJobRuntimeRouter.");
  }

  async cancel(_id: string): Promise<boolean> {
    throw new Error("Unscoped job cancellation is disabled by TenantJobRuntimeRouter.");
  }

  async list(): Promise<JobRecord[]> {
    // Materialize every configured owner runtime so each can load and recover its
    // own persisted jobs after restart before the API returns an aggregate list.
    const pending = await Promise.all([...this.allowedOwners].map((owner) => this.runtimeFor(owner)));
    const records: JobRecord[] = [];
    for (const runtime of pending) records.push(...await runtime.list());
    return records;
  }

  async markNotificationDelivered(id: string): Promise<void> {
    const record = await this.get(id);
    if (!record?.ownerKeyId) return;
    const runtime = await this.runtimeFor(record.ownerKeyId);
    await runtime.markNotificationDelivered?.(id);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      const settled = await Promise.allSettled([...this.runtimes.values()]);
      const failures: unknown[] = [];
      for (const result of settled) {
        if (result.status === "rejected") {
          failures.push(result.reason);
          continue;
        }
        try { await result.value.close?.(); } catch (error) { failures.push(error); }
      }
      this.runtimes.clear();
      if (failures.length) throw new AggregateError(failures, "One or more tenant job runtimes failed to close.");
    })();
    return this.closePromise;
  }
}


/**
 * Connect the API owner router to the same resolver-backed dependency registry
 * used by interactive Agent runs. The registry remains the lifecycle owner of
 * tenant dependencies; this adapter deliberately does not close them a second time.
 */
export function createRegistryBackedTenantJobRuntimeRouter(
  ownerKeyIds: readonly string[],
  registry: TenantDependencyRegistry,
): TenantJobRuntimeRouter {
  return new TenantJobRuntimeRouter(ownerKeyIds, async (ownerKeyId) => {
    const dependencies = await registry.getForPrincipal(ownerKeyId);
    const runtime = dependencies.jobRuntime;
    if (!runtime) throw new Error("Tenant Agent dependencies do not provide a JobRuntime.");
    if (!runtime.getForOwner || !runtime.resumeForOwner || !runtime.cancelForOwner) {
      throw new Error("Tenant JobRuntime must implement owner-scoped lookup, resume, and cancellation.");
    }
    return {
      submit: runtime.submit.bind(runtime),
      get: runtime.get.bind(runtime),
      ...(runtime.getForOwner ? { getForOwner: runtime.getForOwner.bind(runtime) } : {}),
      resume: runtime.resume.bind(runtime),
      ...(runtime.resumeForOwner ? { resumeForOwner: runtime.resumeForOwner.bind(runtime) } : {}),
      cancel: runtime.cancel.bind(runtime),
      ...(runtime.cancelForOwner ? { cancelForOwner: runtime.cancelForOwner.bind(runtime) } : {}),
      list: runtime.list.bind(runtime),
      ...(runtime.markNotificationDelivered ? { markNotificationDelivered: runtime.markNotificationDelivered.bind(runtime) } : {}),
      // TenantDependencyRegistry closes the full dependency bundle at API shutdown.
      close: async () => undefined,
    };
  });
}
