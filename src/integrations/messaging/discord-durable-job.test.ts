import assert from "node:assert/strict";
import test from "node:test";
import type { JobRecord, JobRuntime } from "../../brain/job-runtime.js";
import { runDiscordTaskAsDurableJob } from "./discord-durable-job.js";

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
