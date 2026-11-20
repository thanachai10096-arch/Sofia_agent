import assert from "node:assert/strict";
import test from "node:test";
import { createRegistryBackedTenantJobRuntimeRouter, TenantJobRuntimeRouter } from "./tenant-job-runtime.js";
import type { TenantDependencyRegistry } from "../platform/tenant-dependency-registry.js";
import type { JobRecord, JobRuntime } from "./job-runtime.js";

const ownerOne = "11111111111111111111111111111111";
const ownerTwo = "22222222222222222222222222222222";

function fakeRuntime(ownerKeyId: string, closed: string[]): JobRuntime {
  const jobs = new Map<string, JobRecord>();
  return {
    async submit(input) {
      const record: JobRecord = {
        id: ownerKeyId + "-job",
        ownerKeyId,
        task: input.task,
        status: "queued",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
      jobs.set(record.id, record);
      return record;
    },
    async get(id) { return jobs.get(id); },
    async getForOwner(id, owner) {
      const record = jobs.get(id);
      return record?.ownerKeyId === owner ? record : undefined;
    },
    async resume(id) {
      const record = jobs.get(id);
      if (!record) throw new Error("Unknown job");
      return record;
    },
    async resumeForOwner(id, owner) {
      const record = await this.getForOwner?.(id, owner);
      if (!record) throw new Error("Unknown job");
      return record;
    },
    async cancel() { return false; },
    async cancelForOwner(id, owner) {
      const record = await this.getForOwner?.(id, owner);
      if (!record) return false;
      record.status = "cancelled";
      return true;
    },
    async list() { return [...jobs.values()]; },
    async close() { closed.push(ownerKeyId); },
  };
}

test("TenantJobRuntimeRouter isolates job submission, lookup, cancellation, and shutdown by owner", async () => {
  const created: string[] = [];
  const closed: string[] = [];
  const router = new TenantJobRuntimeRouter([ownerOne, ownerTwo], (owner) => {
    created.push(owner);
    return fakeRuntime(owner, closed);
  });

  const first = await router.submit({ task: "owner one task", ownerKeyId: ownerOne });
  const second = await router.submit({ task: "owner two task", ownerKeyId: ownerTwo });
  assert.equal(first.ownerKeyId, ownerOne);
  assert.equal(second.ownerKeyId, ownerTwo);
  assert.equal(await router.getForOwner(first.id, ownerTwo), undefined);
  assert.equal((await router.getForOwner(first.id, ownerOne))?.id, first.id);
  assert.equal(await router.cancelForOwner(first.id, ownerTwo), false);
  assert.equal(await router.cancelForOwner(first.id, ownerOne), true);
  assert.deepEqual((await router.list()).map((job) => job.ownerKeyId).sort(), [ownerOne, ownerTwo]);
  assert.deepEqual(created.sort(), [ownerOne, ownerTwo]);
  await Promise.all([router.close(), router.close()]);
  assert.deepEqual(closed.sort(), [ownerOne, ownerTwo]);
});

test("TenantJobRuntimeRouter hydrates every owner before a cross-runtime job lookup", async () => {
  const created: string[] = [];
  const restored: JobRecord = {
    id: "owner-two-restored-job",
    ownerKeyId: ownerTwo,
    task: "restored after process restart",
    status: "queued",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const router = new TenantJobRuntimeRouter([ownerOne, ownerTwo], (owner) => {
    created.push(owner);
    return {
      async submit() { throw new Error("unused"); },
      async get(id) { return owner === ownerTwo && id === restored.id ? restored : undefined; },
      async getForOwner(id, requestedOwner) {
        return requestedOwner === ownerTwo && id === restored.id ? restored : undefined;
      },
      async resume() { throw new Error("unused"); },
      async resumeForOwner() { throw new Error("unused"); },
      async cancel() { return false; },
      async cancelForOwner() { return false; },
      async list() { return owner === ownerTwo ? [restored] : []; },
    };
  });

  assert.deepEqual(await router.get(restored.id), restored);
  assert.deepEqual(created.sort(), [ownerOne, ownerTwo]);
  await router.close();
});

test("TenantJobRuntimeRouter rejects one runtime instance reused across tenants", async () => {
  const shared = fakeRuntime(ownerOne, []);
  const router = new TenantJobRuntimeRouter([ownerOne, ownerTwo], () => shared);
  const outcomes = await Promise.allSettled([
    router.submit({ task: "owner one", ownerKeyId: ownerOne }),
    router.submit({ task: "owner two", ownerKeyId: ownerTwo }),
  ]);
  assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(item => item.status === "rejected").length, 1);
  await router.close();
});

test("TenantJobRuntimeRouter rejects missing, malformed, and unconfigured owners", async () => {
  assert.throws(() => new TenantJobRuntimeRouter([ownerOne, ownerOne], () => fakeRuntime(ownerOne, [])), /unique/u);
  assert.throws(() => new TenantJobRuntimeRouter(["client-controlled"], () => fakeRuntime(ownerOne, [])), /32-character/u);
  const router = new TenantJobRuntimeRouter([ownerOne], (owner) => fakeRuntime(owner, []));
  await assert.rejects(() => router.submit({ task: "missing owner" }), /server-derived ownerKeyId/u);
  await assert.rejects(() => router.submit({ task: "unknown owner", ownerKeyId: ownerTwo }), /Unknown job owner/u);
  await assert.rejects(() => router.resume("any-job"), /Unscoped job resume is disabled/u);
  await assert.rejects(() => router.cancel("any-job"), /Unscoped job cancellation is disabled/u);
  await router.close();
});


test("registry-backed routing rejects runtimes without owner-scoped operations", async () => {
  const registry = {
    async getForPrincipal() {
      return {
        jobRuntime: {
          async submit() { throw new Error("unused"); },
          async get() { return undefined; },
          async resume() { throw new Error("unused"); },
          async cancel() { return false; },
          async list() { return []; },
        },
      };
    },
  } as unknown as TenantDependencyRegistry;
  const router = createRegistryBackedTenantJobRuntimeRouter([ownerOne], registry);
  await assert.rejects(
    () => router.submit({ task: "must not route", ownerKeyId: ownerOne }),
    /owner-scoped lookup, resume, and cancellation/u,
  );
  await router.close();
});

test("registry-backed job routing reuses the exact tenant Agent dependency bundle", async () => {
  const closed: string[] = [];
  const runtimes = new Map<string, JobRuntime>();
  const registry = {
    async getForPrincipal(ownerKeyId: string) {
      let runtime = runtimes.get(ownerKeyId);
      if (!runtime) {
        runtime = fakeRuntime(ownerKeyId, closed);
        runtimes.set(ownerKeyId, runtime);
      }
      return { jobRuntime: runtime };
    },
  } as unknown as TenantDependencyRegistry;
  const router = createRegistryBackedTenantJobRuntimeRouter([ownerOne, ownerTwo], registry);
  const one = await router.submit({ task: "reuse owner one Agent", ownerKeyId: ownerOne });
  const two = await router.submit({ task: "reuse owner two Agent", ownerKeyId: ownerTwo });
  assert.equal(one.ownerKeyId, ownerOne);
  assert.equal(two.ownerKeyId, ownerTwo);
  assert.equal(runtimes.size, 2);
  await router.close();
  // The registry, not the router adapter, owns full dependency lifecycle shutdown.
  assert.deepEqual(closed, []);
});
