import assert from "node:assert/strict";
import test from "node:test";

import {
  assessWorkflowRetry,
  createWorkflowPlan,
  readyWorkflowSteps,
  transitionWorkflowStep,
  workflowStepDependenciesSatisfied,
} from "./workflow-plan.js";

const definitions = [
  { id: "prepare", title: "Prepare", description: "Validate the source input", idempotent: true },
  { id: "publish", title: "Publish", description: "Publish an external update", dependsOn: ["prepare"], idempotent: true, consequential: true, risk: "high" as const },
  { id: "notify", title: "Notify", description: "Send a completion notification", dependsOn: ["publish"], idempotent: false },
];

test("workflow plan validates dependencies and returns only dependency-ready steps", () => {
  const plan = createWorkflowPlan("release", definitions, { id: "test-workflow", now: "2026-10-15T00:00:00.000Z" });
  assert.equal(plan.status, "draft");
  assert.deepEqual(readyWorkflowSteps(plan).map((step) => step.id), ["prepare"]);
  assert.equal(workflowStepDependenciesSatisfied(plan, "publish"), false);
  assert.throws(() => createWorkflowPlan("bad", [
    { id: "a", title: "A", description: "A", idempotent: true, dependsOn: ["b"] },
    { id: "b", title: "B", description: "B", idempotent: true, dependsOn: ["a"] },
  ]), /Circular workflow dependency/);
  assert.throws(() => createWorkflowPlan("bad", [
    { id: "a", title: "A", description: "A", idempotent: true, dependsOn: ["missing"] },
  ]), /Unknown workflow dependency/);
});

test("workflow state transitions require completed dependencies and checkpoint before consequential actions", () => {
  let plan = createWorkflowPlan("release", definitions, { now: "2026-10-15T00:00:00.000Z" });
  assert.throws(() => transitionWorkflowStep(plan, "publish", "ready"), /dependencies are not satisfied/);
  plan = transitionWorkflowStep(plan, "prepare", "ready");
  plan = transitionWorkflowStep(plan, "prepare", "running");
  plan = transitionWorkflowStep(plan, "prepare", "succeeded", { evidenceIds: ["evidence-1"] });
  assert.deepEqual(readyWorkflowSteps(plan).map((step) => step.id), ["publish"]);
  plan = transitionWorkflowStep(plan, "publish", "ready");
  assert.throws(() => transitionWorkflowStep(plan, "publish", "running"), /require a checkpoint/);
  plan = transitionWorkflowStep(plan, "publish", "running", { checkpointId: "checkpoint-1" });
  assert.equal(plan.steps.find((step) => step.id === "publish")?.attempts, 1);
  assert.throws(() => transitionWorkflowStep(plan, "publish", "pending"), /Invalid workflow transition/);
});

test("workflow retry policy blocks duplicate or uncertain side effects", () => {
  assert.equal(assessWorkflowRetry({ idempotent: true, sideEffectKnown: "none" }).allowed, true);
  assert.equal(assessWorkflowRetry({ idempotent: false, sideEffectKnown: "none" }).allowed, false);
  assert.equal(assessWorkflowRetry({ idempotent: true, sideEffectKnown: "unknown" }).requiresApproval, true);
  assert.equal(assessWorkflowRetry({ idempotent: true, sideEffectKnown: "completed" }).allowed, false);
  assert.equal(assessWorkflowRetry({ idempotent: true, sideEffectKnown: "none", consequential: true }).allowed, false);
  const approved = assessWorkflowRetry({ idempotent: true, sideEffectKnown: "none", consequential: true, checkpointAvailable: true });
  assert.equal(approved.allowed, true);
  assert.equal(approved.requiresApproval, true);
});

test("workflow transitions retain bounded evidence and error detail", () => {
  let plan = createWorkflowPlan("simple", [{ id: "one", title: "One", description: "Do one thing", idempotent: true }]);
  plan = transitionWorkflowStep(plan, "one", "ready");
  plan = transitionWorkflowStep(plan, "one", "running");
  plan = transitionWorkflowStep(plan, "one", "failed", { error: "x".repeat(1500), evidenceIds: Array.from({ length: 120 }, (_, i) => `e${i}`) });
  const step = plan.steps[0]!;
  assert.equal(step.lastError?.length, 1000);
  assert.equal(step.evidenceIds.length, 100);
  assert.equal(plan.status, "failed");
});
