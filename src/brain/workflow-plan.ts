import { randomUUID } from "node:crypto";
import type { WorkflowPlan, WorkflowPlanStatus, WorkflowStepRecord, WorkflowStepStatus, WorkflowRisk } from "./workflow-plan-store.js";

export interface WorkflowStepDefinition {
  id: string;
  title: string;
  description: string;
  idempotent: boolean;
  dependsOn?: string[];
  risk?: WorkflowRisk;
  maxAttempts?: number;
}
export interface RetryAssessment { retry: boolean; reason: string }

const STEP_STATUSES = new Set<WorkflowStepStatus>([
  "pending", "ready", "running", "waiting_approval", "succeeded", "failed", "skipped", "cancelled",
]);

function validTimestamp(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateDefinitions(definitions: readonly WorkflowStepDefinition[]): void {
  if (!Array.isArray(definitions) || definitions.length < 1 || definitions.length > 100) {
    throw new Error("Workflow must contain between 1 and 100 steps.");
  }
  const byId = new Map<string, WorkflowStepDefinition>();
  for (const step of definitions) {
    if (!step || typeof step.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(step.id) ||
        byId.has(step.id) || typeof step.title !== "string" || !step.title.trim() || step.title.length > 240 ||
        typeof step.description !== "string" || step.description.length > 4_000 ||
        typeof step.idempotent !== "boolean") {
      throw new Error("Workflow step definition is invalid.");
    }
    if (step.risk !== undefined && !["low", "medium", "high"].includes(step.risk)) {
      throw new Error("Workflow step risk is invalid.");
    }
    if (step.maxAttempts !== undefined &&
        (!Number.isSafeInteger(step.maxAttempts) || step.maxAttempts < 1 || step.maxAttempts > 10)) {
      throw new Error("Workflow step maxAttempts must be an integer from 1 to 10.");
    }
    const dependencies = step.dependsOn ?? [];
    if (!Array.isArray(dependencies) || dependencies.some(id => typeof id !== "string") ||
        new Set(dependencies).size !== dependencies.length || dependencies.includes(step.id)) {
      throw new Error("Workflow step dependencies are invalid.");
    }
    byId.set(step.id, step);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("Workflow dependencies must not contain cycles.");
    if (visited.has(id)) return;
    const step = byId.get(id);
    if (!step) throw new Error("Workflow dependency references an unknown step: " + id);
    visiting.add(id);
    for (const dependency of step.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}

export function createWorkflowPlan(
  title: string,
  definitions: readonly WorkflowStepDefinition[],
  options: { id?: string; now?: string } = {},
): WorkflowPlan {
  if (typeof title !== "string" || !title.trim() || title.length > 240) {
    throw new Error("Workflow title must be non-empty and at most 240 characters.");
  }
  const now = options.now ?? new Date().toISOString();
  if (!validTimestamp(now)) throw new Error("Workflow timestamp must be a valid date.");
  const id = options.id ?? randomUUID();
  if (typeof id !== "string" || !id.trim() || id.length > 256) {
    throw new Error("Workflow ID must be non-empty and at most 256 characters.");
  }
  validateDefinitions(definitions);
  return {
    id,
    title: title.trim(),
    createdAt: now,
    updatedAt: now,
    status: "draft",
    steps: definitions.map(step => ({
      id: step.id,
      title: step.title.trim(),
      description: step.description,
      idempotent: step.idempotent,
      dependsOn: [...(step.dependsOn ?? [])],
      risk: step.risk ?? "low",
      maxAttempts: step.maxAttempts ?? 1,
      status: (step.dependsOn?.length ?? 0) === 0 ? "ready" : "pending",
      attempts: 0,
      evidenceIds: [],
      updatedAt: now,
    })),
  };
}

export function workflowStepDependenciesSatisfied(plan: WorkflowPlan, stepId: string): boolean {
  const step = plan.steps.find(item => item.id === stepId);
  if (!step) return false;
  return step.dependsOn.every(id => plan.steps.some(parent => parent.id === id && parent.status === "succeeded"));
}

export function readyWorkflowSteps(plan: WorkflowPlan): WorkflowStepRecord[] {
  return plan.steps
    .filter(step => (step.status === "pending" || step.status === "ready") &&
      workflowStepDependenciesSatisfied(plan, step.id))
    .map(step => ({ ...step, dependsOn: [...step.dependsOn], evidenceIds: [...step.evidenceIds] }));
}

export function transitionWorkflowStep(
  plan: WorkflowPlan,
  stepId: string,
  next: WorkflowStepStatus,
  options: { now?: string; evidenceIds?: string[]; error?: string } = {},
): WorkflowPlan {
  if (!STEP_STATUSES.has(next)) throw new Error("Invalid workflow step status.");
  const allowed: Record<WorkflowStepStatus, readonly WorkflowStepStatus[]> = {
    pending: ["ready", "cancelled", "skipped"],
    ready: ["running", "cancelled", "skipped"],
    running: ["waiting_approval", "succeeded", "failed", "cancelled"],
    waiting_approval: ["running", "cancelled", "failed"],
    succeeded: [],
    failed: ["ready", "cancelled"],
    skipped: [],
    cancelled: [],
  };
  const step = plan.steps.find(item => item.id === stepId);
  if (!step) throw new Error("Unknown workflow step: " + stepId);
  if (!allowed[step.status].includes(next)) {
    throw new Error("Invalid workflow step transition: " + step.status + " -> " + next);
  }
  if (next === "running" && !workflowStepDependenciesSatisfied(plan, stepId)) {
    throw new Error("Workflow step dependencies have not succeeded.");
  }
  const now = options.now ?? new Date().toISOString();
  if (!validTimestamp(now)) throw new Error("Workflow timestamp must be a valid date.");
  if (options.evidenceIds !== undefined &&
      (!Array.isArray(options.evidenceIds) || options.evidenceIds.length > 256 ||
       options.evidenceIds.some(id => typeof id !== "string" || !id.trim() || id.length > 256))) {
    throw new Error("Workflow evidence references are invalid.");
  }
  const steps = plan.steps.map(item => item.id !== stepId ? item : ({
    ...item,
    status: next,
    attempts: item.attempts + (next === "running" && item.status !== "waiting_approval" ? 1 : 0),
    evidenceIds: options.evidenceIds
      ? [...new Set([...item.evidenceIds, ...options.evidenceIds])]
      : [...item.evidenceIds],
    updatedAt: now,
    ...(options.error !== undefined ? { lastError: options.error.slice(0, 2_000) } : {}),
  }));
  const terminal = steps.every(item => ["succeeded", "skipped", "cancelled"].includes(item.status));
  const hasFailure = steps.some(item => item.status === "failed");
  const hasApproval = steps.some(item => item.status === "waiting_approval");
  const status: WorkflowPlanStatus = terminal
    ? (steps.every(item => item.status === "succeeded" || item.status === "skipped") ? "completed" : "cancelled")
    : hasApproval ? "waiting_approval" : hasFailure ? "failed" : "running";
  return { ...plan, updatedAt: now, status, steps };
}

export function assessWorkflowRetry(step: WorkflowStepRecord, failureIsTransient: boolean): RetryAssessment {
  if (step.status !== "failed") return { retry: false, reason: "Only failed steps can be retried." };
  if (!step.idempotent) return { retry: false, reason: "Non-idempotent step requires review before retry." };
  if (!failureIsTransient) return { retry: false, reason: "Failure is not classified as transient." };
  if (step.attempts >= (step.maxAttempts ?? 1)) return { retry: false, reason: "Step retry budget exhausted." };
  return { retry: true, reason: "Idempotent step has retry budget remaining." };
}
