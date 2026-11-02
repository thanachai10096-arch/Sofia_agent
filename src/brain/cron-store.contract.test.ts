import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileCronStore, type CronStore } from "./cron-scheduler.js";

async function withStorePair<T>(run: (first: CronStore, second: CronStore) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-cron-store-contract-"));
  const namespace = "contract-" + path.basename(root);
  try {
    const first = new FileCronStore(namespace, root);
    const second = new FileCronStore(namespace, root);
    return await run(first, second);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("FileCronStore rolls back every state collection when a transaction rejects", async () => {
  await withStorePair(async (store) => {
    await store.transact((state) => {
      state.audit.push({ at: new Date(0).toISOString(), actor: "test", action: "before", scheduleId: "schedule-1" });
    });

    await assert.rejects(
      store.transact((state) => {
        state.audit.push({ at: new Date(1).toISOString(), actor: "test", action: "must-rollback", scheduleId: "schedule-1" });
        state.schedules.push({
          id: "schedule-1",
          name: "transaction rollback",
          task: "never dispatch",
          timeZone: "UTC",
          ownerKeyId: "owner-1",
          status: "enabled",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          nextRunAt: new Date(60_000).toISOString(),
          consecutiveFailures: 0,
        });
        throw new Error("abort transaction");
      }),
      /abort transaction/,
    );

    const snapshot = await store.transact((state) => ({
      schedules: [...state.schedules],
      history: [...state.history],
      audit: [...state.audit],
    }));
    assert.equal(snapshot.schedules.length, 0);
    assert.equal(snapshot.history.length, 0);
    assert.deepEqual(snapshot.audit.map((event) => event.action), ["before"]);
  });
});

test("independent FileCronStore instances serialize concurrent transactions without lost updates", async () => {
  await withStorePair(async (first, second) => {
    const transactions = Array.from({ length: 40 }, (_, index) => {
      const store = index % 2 === 0 ? first : second;
      return store.transact(async (state) => {
        const current = state.audit.length;
        await new Promise((resolve) => setTimeout(resolve, index % 3));
        state.audit.push({
          at: new Date(index).toISOString(),
          actor: "worker-" + (index % 2),
          action: "increment-" + current,
          scheduleId: "schedule-shared",
        });
      });
    });

    await Promise.all(transactions);
    const final = await first.transact((state) => state.audit.map((event) => event.action));
    assert.equal(final.length, 40);
    assert.equal(new Set(final).size, 40);
  });
});

test("FileCronStore persists a complete snapshot that a new instance can read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-cron-store-restart-"));
  const namespace = "restart-" + path.basename(root);
  try {
    const first = new FileCronStore(namespace, root);
    await first.transact((state) => {
      state.audit.push({ at: new Date(0).toISOString(), actor: "owner", action: "schedule.created", scheduleId: "schedule-2" });
      state.history.push({
        id: "execution-1",
        scheduleId: "schedule-2",
        scheduledFor: new Date(60_000).toISOString(),
        startedAt: new Date(60_000).toISOString(),
        status: "claimed",
        attempt: 1,
      });
    });

    const second = new FileCronStore(namespace, root);
    const restored = await second.transact((state) => state);
    assert.equal(restored.audit[0]?.action, "schedule.created");
    assert.equal(restored.history[0]?.status, "claimed");
    assert.equal(restored.schedules.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
