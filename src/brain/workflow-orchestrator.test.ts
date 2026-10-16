import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkflowPlan } from "./workflow-plan.js";
import { WorkflowOrchestrator } from "./workflow-orchestrator.js";
import { FileWorkflowPlanStore } from "./workflow-plan-store.js";

test("WorkflowOrchestrator persists dependency-ordered results and evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-orchestrator-"));
  try {
    const store = new FileWorkflowPlanStore("runner", root);
    const plan = createWorkflowPlan("ordered", [
      { id: "inspect", title: "Inspect", description: "Gather evidence", idempotent: true },
      { id: "change", title: "Change", description: "Apply approved change", idempotent: false, dependsOn: ["inspect"] },
    ], { id: "ordered-plan", ownerPrincipalId: "principal-a" });
    await store.save(plan);
    const executionOrder: string[] = [];
    const runner = new WorkflowOrchestrator({
      store,
      executeStep: async (step) => {
        executionOrder.push(step.id);
        return { status: "succeeded", evidenceIds: ["evidence-" + step.id] };
      },
    });
    const summary = await runner.run("ordered-plan", { principalId: "principal-a", workspaceRoot: root });
    assert.equal(summary.plan.status, "completed");
    assert.equal(summary.completedSteps, 2);
    assert.deepEqual(executionOrder, ["inspect", "change"]);
    assert.deepEqual((await store.load("ordered-plan"))?.steps.map(step => step.status), ["succeeded", "succeeded"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WorkflowOrchestrator pauses for approval and only continues after explicit approval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-orchestrator-approval-"));
  try {
    const store = new FileWorkflowPlanStore("approval", root);
    await store.save(createWorkflowPlan("approval", [
      { id: "publish", title: "Publish", description: "External side effect", idempotent: false, risk: "high" },
      { id: "independent", title: "Independent", description: "Must pause with the workflow", idempotent: true },
    ], { id: "approval-plan", ownerPrincipalId: "principal-a" }));
    const calls: string[] = [];
    const runner = new WorkflowOrchestrator({
      store,
      executeStep: async (step, context) => {
        calls.push(step.id + ":" + context.approved);
        if (step.id === "publish" && !context.approved) {
          return { status: "waiting_approval", reason: "Requires explicit approval." };
        }
        return { status: "succeeded", evidenceIds: ["result-" + step.id] };
      },
    });
    const paused = await runner.run("approval-plan", { principalId: "principal-a", workspaceRoot: root });
    assert.equal(paused.pausedForApproval, true);
    assert.equal(paused.plan.status, "waiting_approval");
    assert.deepEqual(calls, ["publish:false"]);
    const completed = await runner.run("approval-plan", {
      principalId: "principal-a",
      workspaceRoot: root,
      approvedStepIds: ["publish"],
    });
    assert.equal(completed.plan.status, "completed");
    assert.deepEqual(calls, ["publish:false", "publish:true", "independent:false"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WorkflowOrchestrator rejects a different principal before executing steps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-orchestrator-owner-"));
  try {
    const store = new FileWorkflowPlanStore("owner", root);
    await store.save(createWorkflowPlan("private", [
      { id: "step", title: "Step", description: "Private", idempotent: true },
    ], { id: "private-plan", ownerPrincipalId: "principal-a" }));
    let invoked = false;
    const runner = new WorkflowOrchestrator({
      store,
      executeStep: async () => { invoked = true; return { status: "succeeded" }; },
    });
    await assert.rejects(
      () => runner.run("private-plan", { principalId: "principal-b", workspaceRoot: root }),
      /owner mismatch/,
    );
    assert.equal(invoked, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WorkflowOrchestrator cancels a step when its signal aborts before result acceptance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-orchestrator-cancel-"));
  try {
    const store = new FileWorkflowPlanStore("cancel", root);
    await store.save(createWorkflowPlan("cancel", [
      { id: "step-a", title: "A", description: "Running step", idempotent: true },
      { id: "step-b", title: "B", description: "Must not start", idempotent: true },
    ], { id: "cancel-plan", ownerPrincipalId: "principal-a" }));
    const controller = new AbortController();
    let calls = 0;
    const runner = new WorkflowOrchestrator({
      store,
      executeStep: async () => {
        calls += 1;
        controller.abort(new Error("cancel test"));
        return { status: "succeeded" };
      },
    });
    await assert.rejects(
      () => runner.run("cancel-plan", { principalId: "principal-a", workspaceRoot: root, signal: controller.signal }),
    );
    const saved = await store.load("cancel-plan");
    assert.equal(calls, 1);
    assert.equal(saved?.status, "cancelled");
    assert.deepEqual(saved?.steps.map(step => step.status), ["cancelled", "cancelled"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("WorkflowOrchestrator rejects approval for a step not awaiting approval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-orchestrator-bad-approval-"));
  try {
    const store = new FileWorkflowPlanStore("bad-approval", root);
    await store.save(createWorkflowPlan("approval", [
      { id: "step", title: "Step", description: "Not awaiting approval", idempotent: true },
    ], { id: "approval-target-plan", ownerPrincipalId: "principal-a" }));
    const runner = new WorkflowOrchestrator({
      store,
      executeStep: async () => ({ status: "succeeded" }),
    });
    await assert.rejects(
      () => runner.run("approval-target-plan", {
        principalId: "principal-a",
        workspaceRoot: root,
        approvedStepIds: ["step"],
      }),
      /currently awaiting approval/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WorkflowOrchestrator fails closed on malformed executor results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-orchestrator-bad-result-"));
  try {
    const store = new FileWorkflowPlanStore("bad-result", root);
    await store.save(createWorkflowPlan("bad result", [
      { id: "step", title: "Step", description: "Executor contract validation", idempotent: true },
    ], { id: "bad-result-plan", ownerPrincipalId: "principal-a" }));
    const runner = new WorkflowOrchestrator({
      store,
      executeStep: async () => ({ status: "pretend-success" } as never),
    });
    await assert.rejects(
      () => runner.run("bad-result-plan", { principalId: "principal-a", workspaceRoot: root }),
      /invalid result/,
    );
    assert.equal((await store.load("bad-result-plan"))?.steps[0]?.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
