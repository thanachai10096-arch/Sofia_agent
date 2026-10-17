import assert from "node:assert/strict";
import test from "node:test";
import type { JobRecord, JobRuntime } from "../../brain/job-runtime.js";
import { buildDiscordSessionContext, runDiscordTaskAsDurableJob } from "./discord-durable-job.js";

function runtimeFor(records: JobRecord[]): JobRuntime {
  return {
    async submit(input) {
      const record: JobRecord = {
        id: "discord-job-12345678",
        status: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        task: input.task,
        ownerKeyId: input.ownerKeyId,
      };
      records.push(record);
      return { ...record };
    },
    async get(id) {
      assert.equal(id, "discord-job-12345678");
      return records[records.length - 1] ? { ...records[records.length - 1]! } : undefined;
    },
    async resume() { throw new Error("not used"); },
    async cancel() { return false; },
    async list() { return records.map((record) => ({ ...record })); },
  };
}

test("Discord tasks are submitted with an isolated principal and return the durable result", async () => {
  const records: JobRecord[] = [];
  const runtime = runtimeFor(records);
  const promise = runDiscordTaskAsDurableJob(runtime, "inspect repository", "discord:123", { pollIntervalMs: 0 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  records[0]!.status = "completed";
  records[0]!.result = { summary: "Repository inspected", completed: true } as JobRecord["result"];
  const result = await promise;
  assert.equal(records[0]!.ownerKeyId, "discord:123");
  assert.equal(result.id, "discord-job-12345678");
  assert.equal(result.status, "completed");
  assert.equal(result.summary, "Repository inspected");
});

test("Discord durable job adapter returns failed job details without throwing away the job ID", async () => {
  const records: JobRecord[] = [];
  const runtime = runtimeFor(records);
  const promise = runDiscordTaskAsDurableJob(runtime, "inspect repository", "discord:123", { pollIntervalMs: 0 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  records[0]!.status = "failed";
  records[0]!.error = "Verification failed";
  const result = await promise;
  assert.equal(result.status, "failed");
  assert.equal(result.summary, "Verification failed");
  assert.equal(result.id, "discord-job-12345678");
});

test("Discord durable job adapter rejects empty tasks before submitting", async () => {
  const runtime = runtimeFor([]);
  await assert.rejects(
    () => runDiscordTaskAsDurableJob(runtime, "  ", "discord:123", { pollIntervalMs: 0 }),
    /task is required/i,
  );
});
test("Discord can acknowledge a durable job before its result is available", async () => {
  const records: JobRecord[] = [];
  const runtime = runtimeFor(records);
  const { submitDiscordTask, waitForDiscordTask } = await import("./discord-durable-job.js");
  const handle = await submitDiscordTask(runtime, "long running task", "discord:123");
  assert.equal(handle.id, "discord-job-12345678");
  assert.equal(records[0]!.status, "queued");
  const waiting = waitForDiscordTask(handle, { pollIntervalMs: 0 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  records[0]!.status = "completed";
  records[0]!.result = { summary: "Finished later", completed: true } as JobRecord["result"];
  assert.deepEqual(await waiting, {
    id: "discord-job-12345678",
    status: "completed",
    summary: "Finished later",
  });
});

test("Discord session context is scoped to a session and only uses completed jobs", async () => {
  const records: JobRecord[] = [
    {
      id: "job-a", status: "completed", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      task: "inspect README", ownerKeyId: "discord:123", sessionKey: "discord-session-a",
      result: { summary: "README uses MIT licensing", completed: true } as JobRecord["result"],
    },
    {
      id: "job-b", status: "completed", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
      task: "private other channel", ownerKeyId: "discord:123", sessionKey: "discord-session-b",
      result: { summary: "Do not leak this", completed: true } as JobRecord["result"],
    },
    {
      id: "job-c", status: "running", createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z",
      task: "unfinished task", ownerKeyId: "discord:123", sessionKey: "discord-session-a",
    },
  ];
  const context = await buildDiscordSessionContext(runtimeFor(records), "discord-session-a");
  assert.match(context, /README uses MIT licensing/);
  assert.doesNotMatch(context, /Do not leak this/);
  assert.doesNotMatch(context, /unfinished task/);
  assert.match(context, /untrusted historical data/i);
});
