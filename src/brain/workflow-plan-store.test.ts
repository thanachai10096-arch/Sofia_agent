import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkflowPlan } from "./workflow-plan.js";
import { FileWorkflowPlanStore } from "./workflow-plan-store.js";

test("FileWorkflowPlanStore persists defensive snapshots and lists stored plans", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-workflow-store-"));
  try {
    const store = new FileWorkflowPlanStore("store-test", root);
    const original = createWorkflowPlan("first", [
      { id: "step-a", title: "A", description: "First step", idempotent: true },
    ], { id: "plan-a", now: "2026-10-15T00:00:00.000Z" });
    await store.save(original);
    original.title = "mutated outside store";
    original.steps[0]!.title = "mutated step";

    const loaded = await store.load("plan-a");
    assert.equal(loaded?.title, "first");
    assert.equal(loaded?.steps[0]?.title, "A");
    loaded!.steps[0]!.title = "mutated after load";
    assert.equal((await store.load("plan-a"))?.steps[0]?.title, "A");
    assert.deepEqual((await store.list()).map((plan) => plan.id), ["plan-a"]);

    if (process.platform !== "win32") {
      const directory = path.join(root, createHash("sha256").update("store-test").digest("hex"));
      const file = path.join(directory, createHash("sha256").update("plan-a").digest("hex") + ".json");
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    await store.delete("plan-a");
    assert.equal(await store.load("plan-a"), undefined);
    assert.deepEqual(await store.list(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow run locks are exclusive and cannot be released by another owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-workflow-lock-"));
  try {
    const first = new FileWorkflowPlanStore("shared", root);
    const second = new FileWorkflowPlanStore("shared", root);
    assert.equal(await first.acquireRunLock!("workflow-1", "owner-a"), true);
    assert.equal(await second.acquireRunLock!("workflow-1", "owner-b"), false);
    await assert.rejects(() => second.releaseRunLock!("workflow-1", "owner-b"), /owner mismatch/);
    assert.equal(await second.acquireRunLock!("workflow-1", "owner-b"), false);
    await first.releaseRunLock!("workflow-1", "owner-a");
    assert.equal(await second.acquireRunLock!("workflow-1", "owner-b"), true);
    await second.releaseRunLock!("workflow-1", "owner-b");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed persisted workflow JSON fails closed instead of being treated as a missing plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-workflow-corrupt-"));
  try {
    const store = new FileWorkflowPlanStore("corrupt", root);
    const directory = path.join(root, createHash("sha256").update("corrupt").digest("hex"));
    await import("node:fs/promises").then(({ mkdir }) => mkdir(directory, { recursive: true }));
    const file = path.join(directory, createHash("sha256").update("bad-plan").digest("hex") + ".json");
    await writeFile(file, "{not-json", "utf8");
    await assert.rejects(() => store.load("bad-plan"), /invalid JSON/);
    await assert.rejects(() => store.list(), /invalid JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("FileWorkflowPlanStore serializes concurrent writes across store instances", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-workflow-concurrent-"));
  try {
    const stores = Array.from({ length: 4 }, () => new FileWorkflowPlanStore("concurrent", root));
    const base = createWorkflowPlan("snapshot-0", [
      { id: "step", title: "Step", description: "Persist concurrent updates", idempotent: true },
    ], { id: "shared-plan" });
    await Promise.all(Array.from({ length: 20 }, (_, index) => {
      const snapshot = { ...base, title: `snapshot-${index}`, updatedAt: `2026-10-16T00:00:${String(index).padStart(2, "0")}.000Z` };
      return stores[index % stores.length]!.save(snapshot);
    }));
    const loaded = await stores[0]!.load("shared-plan");
    assert.ok(loaded);
    assert.match(loaded.title, /^snapshot-(?:[0-9]|1[0-9])$/);
    assert.equal(loaded.steps[0]?.id, "step");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("workflow plan factory rejects cycles and unknown dependencies", async () => {
  const { createWorkflowPlan } = await import("./workflow-plan.js");
  assert.throws(() => createWorkflowPlan("cycle", [
    { id: "a", title: "A", description: "", idempotent: true, dependsOn: ["b"] },
    { id: "b", title: "B", description: "", idempotent: true, dependsOn: ["a"] },
  ]), /cycles/);
  assert.throws(() => createWorkflowPlan("unknown", [
    { id: "a", title: "A", description: "", idempotent: true, dependsOn: ["missing"] },
  ]), /unknown step/);
});

test("workflow step lifecycle enforces dependencies and only retries safe transient failures", async () => {
  const {
    createWorkflowPlan,
    readyWorkflowSteps,
    transitionWorkflowStep,
    assessWorkflowRetry,
  } = await import("./workflow-plan.js");
  let plan = createWorkflowPlan("lifecycle", [
    { id: "inspect", title: "Inspect", description: "Read evidence", idempotent: true, maxAttempts: 2 },
    { id: "change", title: "Change", description: "Apply a change", idempotent: false, dependsOn: ["inspect"] },
  ], { id: "lifecycle-plan", now: "2026-10-16T00:00:00.000Z" });
  assert.deepEqual(readyWorkflowSteps(plan).map(step => step.id), ["inspect"]);
  const prematurelyReady = transitionWorkflowStep(plan, "change", "ready");
  assert.throws(() => transitionWorkflowStep(prematurelyReady, "change", "running"), /dependencies/);
  plan = transitionWorkflowStep(plan, "inspect", "running", { now: "2026-10-16T00:00:01.000Z" });
  plan = transitionWorkflowStep(plan, "inspect", "failed", { now: "2026-10-16T00:00:02.000Z", error: "temporary issue" });
  const failed = plan.steps.find(step => step.id === "inspect")!;
  assert.equal(assessWorkflowRetry(failed, true).retry, true);
  plan = transitionWorkflowStep(plan, "inspect", "ready", { now: "2026-10-16T00:00:03.000Z" });
  plan = transitionWorkflowStep(plan, "inspect", "running", { now: "2026-10-16T00:00:04.000Z" });
  plan = transitionWorkflowStep(plan, "inspect", "succeeded", {
    now: "2026-10-16T00:00:05.000Z",
    evidenceIds: ["evidence-1"],
  });
  assert.deepEqual(readyWorkflowSteps(plan).map(step => step.id), ["change"]);
  assert.equal(plan.steps[0]?.evidenceIds[0], "evidence-1");
  const change = plan.steps.find(step => step.id === "change")!;
  assert.equal(assessWorkflowRetry({ ...change, status: "failed" }, true).retry, false);
});


test("FileWorkflowPlanStore refuses cyclic dependency graphs at persistence boundary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-workflow-cycle-"));
  try {
    const store = new FileWorkflowPlanStore("cycle", root);
    const plan = createWorkflowPlan("cycle", [
      { id: "a", title: "A", description: "", idempotent: true },
      { id: "b", title: "B", description: "", idempotent: true },
    ], { id: "cyclic-plan" });
    plan.steps[0]!.dependsOn = ["b"];
    plan.steps[1]!.dependsOn = ["a"];
    await assert.rejects(() => store.save(plan), /invalid workflow plan/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
