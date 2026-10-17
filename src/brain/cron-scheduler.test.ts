import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CronScheduler, FileCronStore, nextCronOccurrence, type CronStore } from "./cron-scheduler.js";
import type { JobRecord, JobRuntime } from "./job-runtime.js";

test("stale lock is not automatically unlinked because that can delete a replacement owner lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sofia-cron-stale-lock-test-"));
  const namespace = "stale-lock-safety-test";
  const id = createHash("sha256").update(namespace).digest("hex");
  const lockPath = path.join(root, id + ".json.lock");
  await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, at: Date.now() }), { mode: 0o600 });
  try {
    const store = new FileCronStore(namespace, root);
    await assert.rejects(() => store.transact(state => state.audit.length), /appears stale.*verify no scheduler process/i);
    await access(lockPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creating a schedule cannot assign it to another owner", async () => {
  const state = { schedules: [] as any[], history: [] as any[], audit: [] as any[] };
  const store: CronStore = { async transact(fn) { return fn(state); } };
  const runtime = { async submit() { throw new Error("unused"); } } as unknown as JobRuntime;
  const scheduler = new CronScheduler(runtime, { store });
  await assert.rejects(() => scheduler.create({
    name: "spoofed", task: "task", runAt: "2026-10-18T00:00:00.000Z", timeZone: "UTC", ownerKeyId: "bob",
  }, "alice"), /owner must match/i);
  assert.equal(state.schedules.length, 0);
});

test("schedule quota is enforced atomically per owner", async () => {
  const state = { schedules: [] as any[], history: [] as any[], audit: [] as any[] };
  const store: CronStore = { async transact(fn) { return fn(state); } };
  const runtime = { async submit() { throw new Error("unused"); } } as unknown as JobRuntime;
  const scheduler = new CronScheduler(runtime, { store, maxSchedulesPerOwner: 1 });
  const input = { name: "limited", task: "task", runAt: "2026-10-18T00:00:00.000Z", timeZone: "UTC", ownerKeyId: "alice" };
  await scheduler.create(input, "alice");
  await assert.rejects(() => scheduler.create({ ...input, name: "second" }, "alice"), /quota exceeded/i);
  await scheduler.create({ ...input, name: "bob schedule", ownerKeyId: "bob" }, "bob");
  assert.equal(state.schedules.length, 2);
});

test("cron next occurrence respects timezone offset and weekday", () => {
  const next = nextCronOccurrence("0 9 * * 1-5", "Asia/Bangkok", new Date("2026-10-16T03:00:00.000Z"));
  assert.equal(next.toISOString(), "2026-10-19T02:00:00.000Z");
});
test("invalid timezone and malformed cron expressions are rejected", () => {
  assert.throws(() => nextCronOccurrence("* * *", "UTC", new Date()));
  assert.throws(() => nextCronOccurrence("* * * * *", "Not/AZone", new Date()));
  assert.throws(() => nextCronOccurrence(",1 * * * *", "UTC", new Date()), /invalid cron field/i);
  assert.throws(() => nextCronOccurrence("1,,2 * * * *", "UTC", new Date()), /invalid cron field/i);
  assert.throws(() => nextCronOccurrence("-5 * * * *", "UTC", new Date()), /invalid cron range/i);
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

test("failed cron jobs retry up to the configured limit", async () => {
  const state = { schedules: [] as any[], history: [] as any[], audit: [] as any[] };
  const store: CronStore = { async transact(fn) { return fn(state); } };
  let submitted = 0;
  const runtime = {
    async submit(input: { task: string; ownerKeyId?: string }) {
      submitted++;
      return { id: "retry-job-" + submitted, status: "queued", task: input.task } as JobRecord;
    },
    async get(id: string) {
      return { id, status: id.endsWith("1") ? "failed" : "completed", task: "retry task", ...(id.endsWith("1") ? { error: "transient failure" } : {}) } as JobRecord;
    },
    async cancel() { return true; }, async list() { return []; }, async resume() { throw new Error("unused"); },
  } as unknown as JobRuntime;
  let now = new Date("2026-10-17T00:00:00.000Z");
  const scheduler = new CronScheduler(runtime, { store, now: () => now });
  const created = await scheduler.create({
    name: "retry", task: "retry task", cron: "* * * * *", timeZone: "UTC", ownerKeyId: "alice", maxRetries: 1,
  }, "alice");
  now = new Date("2026-10-17T00:01:00.000Z");
  await scheduler.tick();
  for (let i = 0; i < 30 && state.history[0]?.status !== "completed"; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(submitted, 2);
  assert.equal(state.history[0].status, "completed");
  assert.equal(state.history[0].attempt, 2);
  assert.equal(state.history[0].scheduleId, created.id);
});


test("skip misfire policy records missed occurrence without submitting a job", async () => {
  const state = { schedules: [] as any[], history: [] as any[], audit: [] as any[] };
  const store: CronStore = { async transact(fn) { return fn(state); } };
  let submitted = 0;
  const runtime = {
    async submit() { submitted++; throw new Error("should not submit skipped occurrence"); },
    async get() { return undefined; }, async cancel() { return true; }, async list() { return []; },
    async resume() { throw new Error("unused"); },
  } as unknown as JobRuntime;
  let now = new Date("2026-10-17T00:00:00.000Z");
  const scheduler = new CronScheduler(runtime, { store, now: () => now });
  await scheduler.create({
    name: "skip-missed", task: "task", cron: "* * * * *", timeZone: "UTC",
    ownerKeyId: "alice", misfirePolicy: "skip",
  }, "alice");
  now = new Date("2026-10-17T00:05:00.000Z");
  await scheduler.tick();
  assert.equal(submitted, 0);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].status, "skipped");
  assert.equal(state.schedules[0].nextRunAt, "2026-10-17T00:06:00.000Z");
});

test("run-once misfire policy coalesces backlog into one execution", async () => {
  const state = { schedules: [] as any[], history: [] as any[], audit: [] as any[] };
  const store: CronStore = { async transact(fn) { return fn(state); } };
  let submitted = 0;
  const runtime = {
    async submit(input: { task: string; ownerKeyId?: string }) {
      submitted++;
      return { id: "misfire-job", status: "completed", task: input.task } as JobRecord;
    },
    async get() { return { id: "misfire-job", status: "completed", task: "task" } as JobRecord; },
    async cancel() { return true; }, async list() { return []; }, async resume() { throw new Error("unused"); },
  } as unknown as JobRuntime;
  let now = new Date("2026-10-17T00:00:00.000Z");
  const scheduler = new CronScheduler(runtime, { store, now: () => now });
  await scheduler.create({
    name: "coalesce-missed", task: "task", cron: "* * * * *", timeZone: "UTC",
    ownerKeyId: "alice", misfirePolicy: "run-once",
  }, "alice");
  now = new Date("2026-10-17T00:05:00.000Z");
  await scheduler.tick();
  for (let i = 0; i < 30 && state.history[0]?.status !== "completed"; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(submitted, 1);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].status, "completed");
  assert.equal(state.history[0].scheduledFor, "2026-10-17T00:01:00.000Z");
  assert.equal(state.schedules[0].nextRunAt, "2026-10-17T00:06:00.000Z");
});


test("recovery reconciles persisted jobs and suppresses indeterminate resubmission", async () => {
  const state = { schedules: [] as any[], history: [] as any[], audit: [] as any[] };
  const store: CronStore = { async transact(fn) { return fn(state); } };
  let submitted = 0;
  const runtime = {
    async submit() { submitted++; throw new Error("recovery must not submit"); },
    async get(id: string) {
      return id === "persisted-job"
        ? { id, status: "completed", task: "already ran" } as JobRecord
        : undefined;
    },
    async cancel() { return true; }, async list() { return []; }, async resume() { throw new Error("unused"); },
  } as unknown as JobRuntime;
  const now = new Date("2026-10-17T00:00:00.000Z");
  const scheduler = new CronScheduler(runtime, { store, now: () => now });
  const schedule = await scheduler.create({
    name: "recover", task: "recovery task", cron: "* * * * *", timeZone: "UTC", ownerKeyId: "alice",
  }, "alice");
  state.history.push(
    { id: "lost-claim", scheduleId: schedule.id, scheduledFor: "2026-10-16T23:58:00.000Z",
      startedAt: "2026-10-16T23:58:00.000Z", status: "claimed", attempt: 0 },
    { id: "known-job", scheduleId: schedule.id, scheduledFor: "2026-10-16T23:59:00.000Z",
      startedAt: "2026-10-16T23:59:00.000Z", status: "running", jobId: "persisted-job", attempt: 1 },
  );
  const result = await scheduler.recover();
  assert.deepEqual(result, { reconciled: 2, monitoring: 0, indeterminate: 1 });
  assert.equal(submitted, 0);
  assert.equal(state.history.find((item: any) => item.id === "lost-claim").status, "failed");
  assert.match(state.history.find((item: any) => item.id === "lost-claim").error, /indeterminate/i);
  assert.equal(state.history.find((item: any) => item.id === "known-job").status, "completed");
});


test("file cron store serializes concurrent processes without losing updates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sofia-cron-lock-test-"));
  const moduleUrl = pathToFileURL(path.join(process.cwd(), "src", "brain", "cron-scheduler.ts")).href;
  const script = "import { FileCronStore } from " + JSON.stringify(moduleUrl) + ";\n" +
    "const store = new FileCronStore('multi-process-lock-test', process.env.CRON_TEST_ROOT);\n" +
    "await store.transact(async state => { await new Promise(resolve => setTimeout(resolve, 40)); " +
    "state.audit.push({ at: new Date().toISOString(), actor: 'test', action: 'lock.test', scheduleId: String(state.audit.length) }); });";
  const runChild = () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, CRON_TEST_ROOT: root },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("cron lock test child exited with code " + code + ": " + stderr)));
  });
  try {
    await Promise.all([runChild(), runChild(), runChild(), runChild()]);
    const store = new FileCronStore("multi-process-lock-test", root);
    const count = await store.transact(state => state.audit.length);
    assert.equal(count, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("one-time schedules execute exactly once and disable after claiming", async () => {
  const state = { schedules: [] as any[], history: [] as any[], audit: [] as any[] };
  const store: CronStore = { async transact(fn) { return fn(state); } };
  let submitted = 0;
  const runtime = {
    async submit(input: { task: string; ownerKeyId?: string }) {
      submitted++;
      return { id: "once-job", status: "completed", task: input.task } as JobRecord;
    },
    async get() { return { id: "once-job", status: "completed", task: "once task" } as JobRecord; },
    async cancel() { return true; }, async list() { return []; }, async resume() { throw new Error("unused"); },
  } as unknown as JobRuntime;
  let now = new Date("2026-10-17T00:00:00.000Z");
  const scheduler = new CronScheduler(runtime, { store, now: () => now });
  const created = await scheduler.create({
    name: "one-time", task: "once task", runAt: "2026-10-17T00:01:00.000Z",
    timeZone: "UTC", ownerKeyId: "alice",
  }, "alice");
  now = new Date("2026-10-17T00:01:00.000Z");
  await scheduler.tick();
  await scheduler.tick();
  for (let i = 0; i < 30 && state.history[0]?.status !== "completed"; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(submitted, 1);
  assert.equal(state.schedules[0].id, created.id);
  assert.equal(state.schedules[0].status, "disabled");
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].status, "completed");
});

test("one-time schedules reject ambiguous or invalid timing input", async () => {
  const store: CronStore = { async transact(fn) { return fn({ schedules: [], history: [], audit: [] }); } };
  const scheduler = new CronScheduler({ async submit() { throw new Error("unused"); } } as unknown as JobRuntime, { store });
  await assert.rejects(() => scheduler.create({
    name: "ambiguous", task: "task", cron: "* * * * *", runAt: "2026-10-17T00:01:00.000Z",
    timeZone: "UTC", ownerKeyId: "alice",
  }, "alice"), /exactly one/i);
  await assert.rejects(() => scheduler.create({
    name: "invalid-once", task: "task", runAt: "not-a-date", timeZone: "UTC", ownerKeyId: "alice",
  }, "alice"), /valid ISO-8601/i);
});


test("cancelling a running schedule disables it and cancels the runtime job", async () => {
  const state = { schedules: [] as any[], history: [] as any[], audit: [] as any[] };
  const store: CronStore = { async transact(fn) { return fn(state); } };
  let submitted = 0;
  let cancelled = false;
  let cancelCalls = 0;
  const runtime = {
    async submit(input: { task: string; ownerKeyId?: string }) {
      submitted++;
      return { id: "cancel-job", status: "queued", task: input.task } as JobRecord;
    },
    async get() {
      return { id: "cancel-job", status: cancelled ? "cancelled" : "queued", task: "cancel task" } as JobRecord;
    },
    async cancel() { cancelled = true; cancelCalls++; return true; },
    async list() { return []; }, async resume() { throw new Error("unused"); },
  } as unknown as JobRuntime;
  let now = new Date("2026-10-17T00:00:00.000Z");
  const scheduler = new CronScheduler(runtime, { store, now: () => now });
  const created = await scheduler.create({
    name: "cancel", task: "cancel task", cron: "* * * * *", timeZone: "UTC", ownerKeyId: "alice",
  }, "alice");
  now = new Date("2026-10-17T00:01:00.000Z");
  await scheduler.tick();
  for (let i = 0; i < 30 && !state.schedules[0]?.lastJobId; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(submitted, 1);
  assert.equal(await scheduler.cancel(created.id, "alice"), true);
  for (let i = 0; i < 30 && state.history[0]?.status !== "cancelled"; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(state.schedules[0].status, "disabled");
  assert.equal(state.history[0].status, "cancelled");
  assert.ok(cancelCalls >= 1);
});

test("execution timeout cancels the runtime job and records failure", async () => {
  const state = { schedules: [] as any[], history: [] as any[], audit: [] as any[] };
  const store: CronStore = { async transact(fn) { return fn(state); } };
  let cancelled = false;
  const runtime = {
    async submit(input: { task: string; ownerKeyId?: string }) {
      return { id: "timeout-job", status: "queued", task: input.task } as JobRecord;
    },
    async get() {
      return { id: "timeout-job", status: cancelled ? "cancelled" : "queued", task: "timeout task" } as JobRecord;
    },
    async cancel() { cancelled = true; return true; },
    async list() { return []; }, async resume() { throw new Error("unused"); },
  } as unknown as JobRuntime;
  let now = new Date("2026-10-17T00:00:00.000Z");
  const scheduler = new CronScheduler(runtime, { store, now: () => now });
  await scheduler.create({
    name: "timeout", task: "timeout task", cron: "* * * * *", timeZone: "UTC",
    ownerKeyId: "alice", timeoutMs: 1_000,
  }, "alice");
  now = new Date("2026-10-17T00:01:00.000Z");
  await scheduler.tick();
  for (let i = 0; i < 150 && state.history[0]?.status !== "failed"; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cancelled, true);
  assert.equal(state.history[0].status, "failed");
  assert.match(state.history[0].error, /timed out/i);
});
