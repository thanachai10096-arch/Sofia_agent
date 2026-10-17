import test from "node:test";
import assert from "node:assert/strict";
import { LocalJobBackend } from "../src/platform/cloud-execution.js";
import type { CloudExecutionBackend } from "../src/platform/cloud-execution.js";
import type { JobRecord, JobRuntime } from "../src/brain/job-runtime.js";

function fakeRuntime(): { runtime: JobRuntime; calls: string[] } {
  const calls: string[] = [];
  const record: JobRecord = {
    id: "job-1",
    status: "queued",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    task: "fixture",
  };
  const runtime: JobRuntime = {
    async submit(input) { calls.push("submit:" + input.task); return { ...record, task: input.task }; },
    async get(id) { calls.push("get:" + id); return id === record.id ? { ...record } : undefined; },
    async resume(id) { calls.push("resume:" + id); return { ...record, status: "completed" }; },
    async cancel(id) { calls.push("cancel:" + id); return id === record.id; },
    async list() { calls.push("list"); return [{ ...record }]; },
  };
  return { runtime, calls };
}

test("LocalJobBackend conforms to the cloud backend contract without changing local semantics", async () => {
  const fake = fakeRuntime();
  const backend: CloudExecutionBackend = new LocalJobBackend(fake.runtime);
  assert.equal(backend.id, "local");
  const submitted = await backend.submit({ task: "run task" });
  assert.equal(submitted.task, "run task");
  assert.equal((await backend.get("job-1"))?.id, "job-1");
  assert.equal(await backend.cancel("job-1"), true);
  assert.deepEqual(fake.calls, ["submit:run task", "get:job-1", "cancel:job-1"]);
});

test("LocalJobBackend preserves missing-job behavior", async () => {
  const fake = fakeRuntime();
  const backend = new LocalJobBackend(fake.runtime);
  assert.equal(await backend.get("missing"), undefined);
  assert.equal(await backend.cancel("missing"), false);
});
