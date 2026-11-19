import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileAutonomyJobStore } from "./job-store.js";

async function fixture<T>(run: (store: FileAutonomyJobStore) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-autonomy-jobs-"));
  try { return await run(new FileAutonomyJobStore("test-namespace", root)); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("job enqueue is idempotent within a principal and isolated across principals", async () => {
  await fixture(async (store) => {
    const first = await store.enqueue({ principalId: "user-a", kind: "research", payload: { topic: "ci" }, idempotencyKey: "daily-ci" });
    const duplicate = await store.enqueue({ principalId: "user-a", kind: "research", payload: { topic: "changed" }, idempotencyKey: "daily-ci" });
    const other = await store.enqueue({ principalId: "user-b", kind: "research", payload: { topic: "ci" }, idempotencyKey: "daily-ci" });
    assert.equal(duplicate.id, first.id);
    assert.notEqual(other.id, first.id);
    assert.equal((await store.list("user-a")).length, 1);
    assert.equal(await store.get("user-b", first.id), undefined);
  });
});

test("worker lease controls claim, heartbeat and completion", async () => {
  await fixture(async (store) => {
    const job = await store.enqueue({ principalId: "user-a", kind: "research", payload: { topic: "runtime" } });
    const claimed = await store.claimNext("worker-1", 10_000);
    assert.equal(claimed?.id, job.id);
    assert.equal(claimed?.attempts, 1);
    await assert.rejects(() => store.complete("user-a", job.id, "worker-2", { ok: true }), /does not own/i);
    await store.heartbeat("user-a", job.id, "worker-1", 10_000);
    const completed = await store.complete("user-a", job.id, "worker-1", { ok: true });
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.result, { ok: true });
    assert.equal(await store.claimNext("worker-1", 10_000), undefined);
  });
});

test("expired leases are recovered and retry attempts remain bounded", async () => {
  await fixture(async (store) => {
    const job = await store.enqueue({ principalId: "user-a", kind: "research", payload: {}, maxAttempts: 2 });
    await store.claimNext("worker-1", 1_000);
    const recovered = await store.recoverExpired(new Date(Date.now() + 2_000));
    assert.equal(recovered, 1);
    const retry = await store.claimNext("worker-2", 10_000);
    assert.equal(retry?.id, job.id);
    assert.equal(retry?.attempts, 2);
    const exhausted = await store.recoverExpired(new Date(Date.now() + 20_000));
    assert.equal(exhausted, 1);
    assert.equal((await store.get("user-a", job.id))?.status, "failed");
  });
});

test("retryable failures requeue only while attempts remain; cancellation is terminal", async () => {
  await fixture(async (store) => {
    const job = await store.enqueue({ principalId: "user-a", kind: "research", payload: {}, maxAttempts: 2 });
    await store.claimNext("worker-1", 10_000);
    const requeued = await store.fail("user-a", job.id, "worker-1", "temporary provider error", true);
    assert.equal(requeued.status, "queued");
    await store.claimNext("worker-2", 10_000);
    const failed = await store.fail("user-a", job.id, "worker-2", "provider still unavailable", true);
    assert.equal(failed.status, "failed");
    const another = await store.enqueue({ principalId: "user-a", kind: "research", payload: {} });
    const cancelled = await store.cancel("user-a", another.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(await store.cancel("user-a", another.id).then((x) => x.status), "cancelled");
  });
});

test("checkpoint survives worker interruption and remains principal-scoped", async () => {
  await fixture(async (store) => {
    const job = await store.enqueue({ principalId: "user-a", kind: "research", payload: {} });
    await store.claimNext("worker-1", 10_000);
    const checkpoint = { nextCycle: 2, cycles: [{ cycle: 1, status: "learned" }] };
    await store.saveCheckpoint("user-a", job.id, "worker-1", checkpoint);
    const persisted = await store.get("user-a", job.id);
    assert.deepEqual(persisted?.checkpoint?.cycles, checkpoint.cycles);
    assert.equal(persisted?.checkpoint?.nextCycle, 2);
    assert.equal(await store.get("user-b", job.id), undefined);
    await store.recoverExpired(new Date(Date.now() + 20_000));
    const resumed = await store.claimNext("worker-2", 10_000);
    assert.deepEqual(resumed?.checkpoint?.cycles, checkpoint.cycles);
    assert.equal(resumed?.checkpoint?.nextCycle, 2);
  });
});

test("local checkpoint rejects gaps, regressions and skipped cycle numbers", async () => {
  await fixture(async (store) => {
    const job = await store.enqueue({ principalId: "user-a", kind: "research", payload: {} });
    await store.claimNext("worker-1", 10_000);
    await assert.rejects(
      () => store.saveCheckpoint("user-a", job.id, "worker-1", { nextCycle: 2, cycles: [{ cycle: 2 }] }),
      /contiguous, completed cycle history/,
    );
    await store.saveCheckpoint("user-a", job.id, "worker-1", { nextCycle: 2, cycles: [{ cycle: 1 }] });
    await assert.rejects(
      () => store.saveCheckpoint("user-a", job.id, "worker-1", { nextCycle: 2, cycles: [{ cycle: 1 }] }),
      /advance exactly one completed cycle/,
    );
    await assert.rejects(
      () => store.saveCheckpoint("user-a", job.id, "worker-1", { nextCycle: 4, cycles: [{ cycle: 1 }, { cycle: 2 }, { cycle: 3 }] }),
      /advance exactly one completed cycle/,
    );
    const advanced = await store.saveCheckpoint("user-a", job.id, "worker-1", {
      nextCycle: 3, cycles: [{ cycle: 1 }, { cycle: 2 }],
    });
    assert.equal(advanced.checkpoint?.nextCycle, 3);
  });
});

test("lease-owned cancellation cannot cancel a job reclaimed by another worker", async () => {
  await fixture(async (store) => {
    const job = await store.enqueue({ principalId: "user-a", kind: "research", payload: {}, maxAttempts: 3 });
    await store.claimNext("worker-old", 1_000);
    await store.recoverExpired(new Date(Date.now() + 2_000));
    const reclaimed = await store.claimNext("worker-new", 10_000);
    assert.equal(reclaimed?.lease?.workerId, "worker-new");

    const staleCancel = await store.cancelOwned("user-a", job.id, "worker-old");
    assert.equal(staleCancel.status, "running");
    assert.equal(staleCancel.lease?.workerId, "worker-new");

    const ownerCancel = await store.cancelOwned("user-a", job.id, "worker-new");
    assert.equal(ownerCancel.status, "cancelled");
    assert.equal(ownerCancel.lease, undefined);
  });
});

