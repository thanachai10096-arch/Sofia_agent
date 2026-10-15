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
    ], { id: "cancel-plan" }));
    const result = await orchestrator.run("cancel-plan", { signal: controller.signal });
    assert.equal(result.plan.steps[0]?.status, "cancelled");
    assert.match(result.stoppedReason ?? "", /partial side effects/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
