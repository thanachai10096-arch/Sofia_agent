import assert from "node:assert/strict";
import test from "node:test";
import { TenantJobRuntimeRouter } from "./tenant-job-runtime.js";
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
