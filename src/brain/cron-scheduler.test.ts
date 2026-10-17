import assert from "node:assert/strict";
import test from "node:test";
import { CronScheduler, nextCronOccurrence, type CronStore } from "./cron-scheduler.js";
import type { JobRecord, JobRuntime } from "./job-runtime.js";

test("cron next occurrence respects timezone offset and weekday", () => {
  const next = nextCronOccurrence("0 9 * * 1-5", "Asia/Bangkok", new Date("2026-10-16T03:00:00.000Z"));
  assert.equal(next.toISOString(), "2026-10-19T02:00:00.000Z");
});
test("invalid timezone and malformed cron expressions are rejected", () => {
  assert.throws(() => nextCronOccurrence("* * *", "UTC", new Date()));
  assert.throws(() => nextCronOccurrence("* * * * *", "Not/AZone", new Date()));
});
test("two scheduler instances cannot claim the same occurrence through a transactional store", async () => {
  const state = { schedules: [] as any[], history: [] as any[], audit: [] as any[] };
  const store: CronStore = { async transact(fn) { return fn(state); } };
  let submitted = 0;
  const runtime = {
    async submit(input: { task: string; ownerKeyId?: string }) {
      submitted++;
      return { id: "job-" + submitted, status: "completed", task: input.task } as JobRecord;
    },
    async get() { return { id: "job", status: "completed", task: "x" } as JobRecord; },
    async cancel() { return true; }, async list() { return []; }, async resume() { throw new Error("unused"); },
  } as unknown as JobRuntime;
  let now = new Date("2026-10-17T00:00:00.000Z");
  const a = new CronScheduler(runtime, { store, now: () => now });
  const b = new CronScheduler(runtime, { store, now: () => now });
  await a.create({ name: "daily", task: "do safe work", cron: "* * * * *", timeZone: "UTC", ownerKeyId: "alice" }, "alice");
  now = new Date("2026-10-17T00:01:00.000Z");
  await Promise.all([a.tick(), b.tick()]);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(submitted, 1);
});
test("authorization prevents another owner from disabling a schedule", async () => {
  const state = { schedules: [] as any[], history: [] as any[], audit: [] as any[] };
  const store: CronStore = { async transact(fn) { return fn(state); } };
  const runtime = { async submit() { throw new Error("unused"); } } as unknown as JobRuntime;
  const scheduler = new CronScheduler(runtime, { store });
  const created = await scheduler.create({ name: "owned", task: "task", cron: "* * * * *", timeZone: "UTC", ownerKeyId: "alice" }, "alice");
  await assert.rejects(() => scheduler.setEnabled(created.id, false, "bob"), /not authorized/i);
});
