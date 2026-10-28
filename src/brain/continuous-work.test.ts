import assert from "node:assert/strict";
import test from "node:test";
import { ContinuousWorkSupervisor, type ContinuousWorkRecord, type ContinuousWorkStore } from "./continuous-work.js";
import type { JobRecord, JobRuntime } from "./job-runtime.js";

class MemoryStore implements ContinuousWorkStore {
  private readonly records = new Map<string, ContinuousWorkRecord>();
  async get(id: string) { const r = this.records.get(id); return r ? { ...r } : undefined; }
  async list(owner?: string) { return [...this.records.values()].filter((r) => owner === undefined || r.ownerKeyId === owner).map((r) => ({ ...r })); }
  async save(record: ContinuousWorkRecord) { this.records.set(record.id, { ...record }); }
}

function fakeJobs() {
  let sequence = 0;
  const records = new Map<string, JobRecord>();
  const jobs: JobRuntime = {
    async submit(input) {
      const id = "job-" + (++sequence);
      const record = { id, status: "completed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), task: input.task,
        ownerKeyId: input.ownerKeyId, result: { completed: true, state: "completed", summary: "Verified progress slice " + sequence } } as unknown as JobRecord;
      records.set(id, record); return { ...record };
    },
    async get(id) { const r = records.get(id); return r ? { ...r } : undefined; },
    async resume(id) { const r = records.get(id); if (!r) throw new Error("missing"); return { ...r }; },
    async cancel() { return true; }, async list() { return [...records.values()]; },
  };
  return jobs;
}

test("continuous work persists progress between bounded activations and can continue indefinitely by default", async () => {
  const store = new MemoryStore();
  const supervisor = new ContinuousWorkSupervisor(fakeJobs(), store, {
    maxIterationsPerActivation: 1,
    isComplete: (record) => record.iteration >= 2,
  });
  const created = await supervisor.create("user-a", "Build and verify a project in increments");
  const first = await supervisor.resume(created.id, "user-a");
  assert.equal(first.status, "paused");
  assert.equal(first.iteration, 1);
  const second = await supervisor.resume(created.id, "user-a");
  assert.equal(second.status, "completed");
  assert.equal(second.iteration, 2);
  assert.equal((await supervisor.list("user-b")).length, 0);
});

test("continuous work rejects anonymous creation and cross-user reads/stops", async () => {
  const supervisor = new ContinuousWorkSupervisor(fakeJobs(), new MemoryStore(), { isComplete: () => false });
  await assert.rejects(supervisor.create("  ", "task"), /authenticated owner/);
  const record = await supervisor.create("owner-1", "task");
  assert.equal(await supervisor.get(record.id, "owner-2"), undefined);
  assert.equal(await supervisor.stop(record.id, "owner-2"), false);
  assert.equal(await supervisor.stop(record.id, "owner-1"), true);
  await assert.rejects(supervisor.resume(record.id, "owner-1"), /cannot be resumed/);
});

test("continuous work validates activation and lifetime limits", async () => {
  assert.throws(() => new ContinuousWorkSupervisor(fakeJobs(), new MemoryStore(), { maxIterationsPerActivation: 101, isComplete: () => false }), /maxIterationsPerActivation/);
  const supervisor = new ContinuousWorkSupervisor(fakeJobs(), new MemoryStore(), { maxLifetimeIterations: 1, isComplete: () => false });
  const record = await supervisor.create("owner", "bounded task");
  const completed = await supervisor.resume(record.id, "owner");
  assert.equal(completed.status, "completed");
  assert.equal(completed.iteration, 1);
});


test("continuous work reconciles a persisted child job instead of submitting a duplicate after restart", async () => {
  const store = new MemoryStore();
  const now = new Date().toISOString();
  const child = {
    id: "persisted-child", status: "completed", createdAt: now, updatedAt: now,
    task: "previous slice", ownerKeyId: "owner",
    result: { completed: true, state: "completed", summary: "Recovered verified checkpoint" },
  } as unknown as JobRecord;
  let submitCalls = 0;
  const jobs: JobRuntime = {
    async submit() { submitCalls += 1; throw new Error("must not submit duplicate work"); },
    async get(id) { return id === child.id ? { ...child } : undefined; },
    async resume() { return { ...child }; },
    async cancel() { return true; },
    async list() { return [{ ...child }]; },
  };
  const record: ContinuousWorkRecord = {
    id: "objective-1", ownerKeyId: "owner", task: "Continue the long-running objective",
    status: "active", iteration: 0, maxIterationsPerActivation: 1, currentJobId: child.id,
    createdAt: now, updatedAt: now,
  };
  await store.save(record);
  const supervisor = new ContinuousWorkSupervisor(jobs, store, { maxIterationsPerActivation: 1, isComplete: () => false });
  assert.equal(await supervisor.resumeInterrupted(), 1);
  let resumed = await store.get(record.id);
  for (let attempt = 0; attempt < 100 && resumed?.iteration !== 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    resumed = await store.get(record.id);
  }
  assert.equal(resumed?.iteration, 1);
  assert.equal(resumed?.lastSummary, "Recovered verified checkpoint");
  assert.equal(resumed?.status, "paused");
  assert.equal(submitCalls, 0);
});
