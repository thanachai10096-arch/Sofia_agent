import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileTaskEfficiencyStore } from "./task-efficiency-store.js";
import type { TaskMeasurement } from "./task-efficiency-metrics.js";

const sample: TaskMeasurement = {
  taskId: "run-safe-1", completed: true, acceptanceCriteria: 1, passedCriteria: 1,
  inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, modelCalls: 1, unmeasuredModelCalls: 0, usageComplete: true, retries: 0,
  durationMs: 123, costKnown: false,
};

test("persists only allow-listed aggregate telemetry and isolates principal namespaces", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sofia-efficiency-"));
  try {
    const first = new FileTaskEfficiencyStore("/workspace/a", "principal-a", root);
    const other = new FileTaskEfficiencyStore("/workspace/a", "principal-b", root);
    await first.append({ ...sample, prompt: "must never be persisted" } as TaskMeasurement);
    assert.deepEqual(await first.readAll(), [sample]);
    assert.deepEqual(await other.readAll(), []);
    const files = await fs.readdir(root);
    assert.equal(files.length, 1);
    const raw = await fs.readFile(path.join(root, files[0]!), "utf8");
    assert.equal(raw.includes("must never be persisted"), false);
    assert.equal(raw.includes("prompt"), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("rejects invalid measurements rather than writing malformed records", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sofia-efficiency-invalid-"));
  try {
    const store = new FileTaskEfficiencyStore("/workspace/a", "principal-a", root);
    await assert.rejects(store.append({ ...sample, passedCriteria: 2 }), /Invalid efficiency measurement/);
    assert.deepEqual(await store.readAll(), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
