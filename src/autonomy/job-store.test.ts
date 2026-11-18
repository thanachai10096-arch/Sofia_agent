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
