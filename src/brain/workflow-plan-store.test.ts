import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkflowPlan, transitionWorkflowStep } from "./workflow-plan.js";
import { FileWorkflowPlanStore } from "./workflow-plan-store.js";

test("workflow plan store persists, reloads, lists, and deletes plans", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-workflow-store-"));
  try {
    const store = new FileWorkflowPlanStore("test-namespace", root);
    let plan = createWorkflowPlan("release", [
      { id: "build", title: "Build", description: "Build project", idempotent: true },
    ], { id: "plan-1", now: "2026-10-15T00:00:00.000Z" });
    await store.save(plan);
    plan = transitionWorkflowStep(plan, "build", "ready");
    await Promise.all([store.save(plan), store.save(plan)]);
    assert.deepEqual(await store.load("plan-1"), plan);
    assert.deepEqual((await store.list()).map((item) => item.id), ["plan-1"]);
    const files = await readdir(path.join(root, (await import("node:crypto")).createHash("sha256").update("test-namespace").digest("hex")));
    assert.equal(files.length, 1);
    await store.delete("plan-1");
    assert.equal(await store.load("plan-1"), undefined);
    assert.deepEqual(await store.list(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow plan store isolates namespaces and rejects malformed state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-workflow-store-"));
  try {
    const first = new FileWorkflowPlanStore("first", root);
    const second = new FileWorkflowPlanStore("second", root);
    const plan = createWorkflowPlan("one", [
      { id: "step", title: "Step", description: "Run step", idempotent: true },
    ], { id: "shared-id" });
    await first.save(plan);
    assert.equal(await second.load("shared-id"), undefined);
    await assert.rejects(() => first.save({ ...plan, steps: [] }), /Invalid workflow plan/);
    const loaded = await first.load("shared-id");
    assert.equal(loaded?.id, "shared-id");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow plan store rejects corrupted persisted JSON", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-workflow-store-"));
  try {
    const store = new FileWorkflowPlanStore("corrupt", root);
    const plan = createWorkflowPlan("corruptible", [
      { id: "step", title: "Step", description: "Run step", idempotent: true },
    ], { id: "corrupt-id" });
    await store.save(plan);
    const namespace = (await import("node:crypto")).createHash("sha256").update("corrupt").digest("hex");
    const file = path.join(root, namespace, (await import("node:crypto")).createHash("sha256").update("corrupt-id").digest("hex") + ".json");
    await (await import("node:fs/promises")).writeFile(file, "{broken", "utf8");
    await assert.rejects(() => store.load("corrupt-id"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
