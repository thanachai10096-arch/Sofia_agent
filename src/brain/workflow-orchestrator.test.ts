import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkflowPlan } from "./workflow-plan.js";
import { FileWorkflowPlanStore } from "./workflow-plan-store.js";
import { WorkflowOrchestrator } from "./workflow-orchestrator.js";

test("orchestrator persists each step and executes dependency order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-orchestrator-"));
  try {
    const store = new FileWorkflowPlanStore("ordered", root);
    const order: string[] = [];
    const orchestrator = new WorkflowOrchestrator({
      store,
      executeStep: async (step) => { order.push(step.id); return { evidenceIds: [`done-${step.id}`] }; },
      now: () => "2026-10-15T00:00:00.000Z",
    });
    await orchestrator.create(createWorkflowPlan("ordered", [
      { id: "a", title: "A", description: "First", idempotent: true },
      { id: "b", title: "B", description: "Second", dependsOn: ["a"], idempotent: true },
    ], { id: "ordered-plan" }));
    const result = await orchestrator.run("ordered-plan");
    assert.deepEqual(order, ["a", "b"]);
    assert.equal(result.plan.status, "completed");
    assert.equal((await store.load("ordered-plan"))?.steps[1]?.evidenceIds[0], "done-b");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("consequential steps require a verified checkpoint and explicit approval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-orchestrator-"));
  try {
    const store = new FileWorkflowPlanStore("approval", root);
    let calls = 0;
    const orchestrator = new WorkflowOrchestrator({
      store,
      createCheckpoint: async () => ({ id: "cp-1", verified: true }),
      requestApproval: async () => false,
      executeStep: async () => { calls++; return {}; },
    });
    await orchestrator.create(createWorkflowPlan("approval", [
      { id: "publish", title: "Publish", description: "Publish external change", idempotent: true, consequential: true },
    ], { id: "approval-plan" }));
    const result = await orchestrator.run("approval-plan");
    assert.equal(result.waitingForApproval, true);
    assert.equal(result.plan.steps[0]?.status, "waiting_approval");
    assert.equal(calls, 0);
    assert.equal((await store.load("approval-plan"))?.steps[0]?.checkpointId, "cp-1");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("orchestrator blocks consequential action when checkpoint cannot be verified", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-orchestrator-"));
  try {
    const store = new FileWorkflowPlanStore("checkpoint", root);
    let calls = 0;
    const orchestrator = new WorkflowOrchestrator({
      store,
      createCheckpoint: async () => ({ id: "cp-1", verified: false }),
      requestApproval: async () => true,
      executeStep: async () => { calls++; return {}; },
    });
    await orchestrator.create(createWorkflowPlan("checkpoint", [
      { id: "publish", title: "Publish", description: "Publish external change", idempotent: true, consequential: true },
    ], { id: "checkpoint-plan" }));
    const result = await orchestrator.run("checkpoint-plan");
    assert.equal(result.waitingForApproval, true);
    assert.equal(calls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("orchestrator stops on failure and never runs downstream steps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-orchestrator-"));
  try {
    const store = new FileWorkflowPlanStore("failure", root);
    const order: string[] = [];
    const orchestrator = new WorkflowOrchestrator({
      store,
      executeStep: async (step) => { order.push(step.id); if (step.id === "a") throw new Error("deliberate failure"); return {}; },
    });
    await orchestrator.create(createWorkflowPlan("failure", [
      { id: "a", title: "A", description: "Fail", idempotent: true },
      { id: "b", title: "B", description: "Must not run", dependsOn: ["a"], idempotent: true },
    ], { id: "failure-plan" }));
    const result = await orchestrator.run("failure-plan");
    assert.deepEqual(order, ["a"]);
    assert.equal(result.plan.status, "failed");
    assert.equal(result.plan.steps[1]?.status, "pending");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent run requests do not execute the same workflow twice in one orchestrator", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-orchestrator-"));
  try {
    const store = new FileWorkflowPlanStore("concurrent", root);
    let calls = 0;
    let markEntered!: () => void;
    let releaseExecution!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const orchestrator = new WorkflowOrchestrator({
      store,
      executeStep: async () => {
        calls += 1;
        markEntered();
        await gate;
        return { evidenceIds: ["executed-once"] };
      },
    });
    await orchestrator.create(createWorkflowPlan("concurrent", [
      { id: "step", title: "Step", description: "Must execute once", idempotent: true },
    ], { id: "concurrent-plan" }));

    const firstRun = orchestrator.run("concurrent-plan");
    await entered;
    const duplicateRun = await orchestrator.run("concurrent-plan");
    assert.equal(duplicateRun.executed, 0);
    assert.match(duplicateRun.stoppedReason ?? "", /already executing/);
    assert.equal(calls, 1);

    releaseExecution();
    const completed = await firstRun;
    assert.equal(completed.plan.status, "completed");
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("separate orchestrators cannot execute the same workflow concurrently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-orchestrator-cross-process-"));
  try {
    const firstStore = new FileWorkflowPlanStore("shared-workflow", root);
    const secondStore = new FileWorkflowPlanStore("shared-workflow", root);
    let calls = 0;
    let markEntered!: () => void;
    let releaseExecution!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const first = new WorkflowOrchestrator({
      store: firstStore,
      executeStep: async () => { calls++; markEntered(); await gate; return {}; },
    });
    const second = new WorkflowOrchestrator({
      store: secondStore,
      executeStep: async () => { calls++; return {}; },
    });
    await first.create(createWorkflowPlan("shared", [
      { id: "step", title: "Step", description: "Must run once", idempotent: true },
    ], { id: "shared-plan" }));

    const firstRun = first.run("shared-plan");
    await entered;
    const duplicate = await second.run("shared-plan");
    assert.equal(duplicate.executed, 0);
    assert.match(duplicate.stoppedReason ?? "", /claimed by another process/);
    assert.equal(calls, 1);

    releaseExecution();
    const result = await firstRun;
    assert.equal(result.plan.status, "completed");
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("interrupted unknown side effects block automatic replay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-orchestrator-"));
  try {
    const store = new FileWorkflowPlanStore("interrupted", root);
    const plan = createWorkflowPlan("interrupted", [
      { id: "step", title: "Step", description: "May have side effects", idempotent: true },
    ], { id: "interrupted-plan" });
    const { transitionWorkflowStep } = await import("./workflow-plan.js");
    await store.save(transitionWorkflowStep(transitionWorkflowStep(plan, "step", "ready"), "step", "running"));
    let calls = 0;
    const orchestrator = new WorkflowOrchestrator({ store, executeStep: async () => { calls++; return {}; } });
    const result = await orchestrator.run("interrupted-plan");
    assert.equal(calls, 0);
    assert.match(result.stoppedReason ?? "", /reconciliation is required/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("already-aborted workflow cancels and persists every unstarted step", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-orchestrator-pre-cancel-"));
  try {
    const store = new FileWorkflowPlanStore("pre-cancel", root);
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const orchestrator = new WorkflowOrchestrator({
      store,
      executeStep: async () => { calls++; return {}; },
    });
    await orchestrator.create(createWorkflowPlan("pre-cancel", [
      { id: "a", title: "A", description: "Do not start", idempotent: true },
      { id: "b", title: "B", description: "Also do not start", dependsOn: ["a"], idempotent: true },
    ], { id: "pre-cancel-plan" }));
    const result = await orchestrator.run("pre-cancel-plan", { signal: controller.signal });
    assert.equal(calls, 0);
    assert.equal(result.plan.status, "cancelled");
    assert.deepEqual(result.plan.steps.map((step) => step.status), ["cancelled", "cancelled"]);
    assert.deepEqual((await store.load("pre-cancel-plan"))?.steps.map((step) => step.status), ["cancelled", "cancelled"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("orchestrator persists cancellation while a step is in flight", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-orchestrator-"));
  try {
    const store = new FileWorkflowPlanStore("cancel", root);
    const controller = new AbortController();
    const orchestrator = new WorkflowOrchestrator({
      store,
      executeStep: async (_step, context) => await new Promise<never>((_resolve, reject) => {
        const signal = context.signal!;
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        setTimeout(() => controller.abort(), 5);
      }),
    });
    await orchestrator.create(createWorkflowPlan("cancel", [
      { id: "step", title: "Step", description: "Long-running action", idempotent: true },
      { id: "next", title: "Next", description: "Must not start after cancellation", dependsOn: ["step"], idempotent: true },
    ], { id: "cancel-plan" }));
    const result = await orchestrator.run("cancel-plan", { signal: controller.signal });
    assert.equal(result.plan.steps[0]?.status, "cancelled");
    assert.equal(result.plan.steps[1]?.status, "cancelled");
    assert.equal(result.plan.status, "cancelled");
    assert.match(result.stoppedReason ?? "", /partial side effects/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
