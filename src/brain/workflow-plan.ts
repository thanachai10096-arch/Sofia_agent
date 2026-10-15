import { randomUUID } from "node:crypto";

export type WorkflowStepStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export type WorkflowRisk = "low" | "medium" | "high";

export interface WorkflowStepDefinition {
  id: string;
  title: string;
  description: string;
  dependsOn?: readonly string[];
  /** Must be true only when repeating the action cannot duplicate harmful side effects. */
  idempotent: boolean;
  /** True for actions that can mutate external systems, publish, spend, or delete. */
  consequential?: boolean;
  risk?: WorkflowRisk;
  /** Optional concrete tool action. Generic planning steps may omit this and use a custom executor. */
  action?: { tool: string; input: Record<string, unknown> };
}

export interface WorkflowStepRecord extends Omit<WorkflowStepDefinition, "dependsOn"> {
  dependsOn: string[];
  status: WorkflowStepStatus;
  attempts: number;
  checkpointId?: string;
  lastError?: string;
  evidenceIds: string[];
  updatedAt: string;
}

export interface WorkflowPlan {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: "draft" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";
  steps: WorkflowStepRecord[];
}

export interface RetryAssessment {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
}

/** Creates a validated workflow record; it does not execute tools or persist state. */
export function createWorkflowPlan(
  title: string,
  definitions: readonly WorkflowStepDefinition[],
  options: { maxSteps?: number; id?: string; now?: string } = {},
): WorkflowPlan {
  if (typeof title !== "string" || !title.trim()) throw new Error("Workflow title must not be empty");
  const maxSteps = options.maxSteps ?? 100;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error("maxSteps must be a positive integer");
  if (definitions.length === 0 || definitions.length > maxSteps) throw new Error("Invalid workflow step count");

  const ids = new Set<string>();
  for (const step of definitions) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(step.id)) throw new Error("Invalid workflow step id");
    if (ids.has(step.id)) throw new Error(`Duplicate workflow step: ${step.id}`);
    ids.add(step.id);
    if (!step.title.trim() || !step.description.trim()) throw new Error("Workflow step title and description are required");
    if (typeof step.idempotent !== "boolean") throw new Error("Workflow step idempotency must be explicit");
    if (step.risk && !["low", "medium", "high"].includes(step.risk)) throw new Error("Invalid workflow risk");
  }

  for (const step of definitions) {
    const deps = step.dependsOn ?? [];
    if (new Set(deps).size !== deps.length) throw new Error(`Duplicate dependency in step: ${step.id}`);
    for (const dependency of deps) {
      if (!ids.has(dependency)) throw new Error(`Unknown workflow dependency: ${dependency}`);
      if (dependency === step.id) throw new Error(`Workflow step cannot depend on itself: ${step.id}`);
    }
  }

  const byId = new Map(definitions.map((step) => [step.id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error(`Circular workflow dependency: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const step of definitions) visit(step.id);

  const now = options.now ?? new Date().toISOString();
  return {
    id: options.id ?? randomUUID(),
    title: title.trim(),
    createdAt: now,
    updatedAt: now,
    status: "draft",
    steps: definitions.map((step) => ({
      ...step,
      dependsOn: [...(step.dependsOn ?? [])],
      status: "pending",
      attempts: 0,
      evidenceIds: [],
      updatedAt: now,
    })),
  };
}

const TRANSITIONS: Record<WorkflowStepStatus, readonly WorkflowStepStatus[]> = {
  // A consequential step may need to pause for approval before it is marked ready to execute.
  pending: ["ready", "waiting_approval", "skipped", "cancelled"],
  ready: ["running", "waiting_approval", "skipped", "cancelled"],
  running: ["succeeded", "failed", "waiting_approval", "cancelled"],
  waiting_approval: ["ready", "cancelled", "skipped"],
  succeeded: [],
  failed: ["ready", "cancelled"],
  skipped: [],
  cancelled: [],
};

/** Enforces legal state transitions; callers remain responsible for durable persistence. */
export function transitionWorkflowStep(
  plan: WorkflowPlan,
  stepId: string,
  next: WorkflowStepStatus,
  details: { now?: string; checkpointId?: string; approved?: boolean; error?: string; evidenceIds?: readonly string[] } = {},
): WorkflowPlan {
  const index = plan.steps.findIndex((step) => step.id === stepId);
  if (index < 0) throw new Error(`Unknown workflow step: ${stepId}`);
  const current = plan.steps[index]!;
  if (!TRANSITIONS[current.status].includes(next)) {
    throw new Error(`Invalid workflow transition: ${current.status} -> ${next}`);
  }
  if (next === "ready" && !workflowStepDependenciesSatisfied(plan, stepId)) {
    throw new Error("Workflow dependencies are not satisfied");
  }
  if (next === "running" && current.consequential && !details.checkpointId) {
    throw new Error("Consequential workflow steps require a checkpoint before execution");
  }
  if (next === "running" && current.consequential && details.approved !== true) {
    throw new Error("Consequential workflow steps require explicit approval before execution");
  }
  const now = details.now ?? new Date().toISOString();
  const updated: WorkflowStepRecord = {
    ...current,
    status: next,
    attempts: current.attempts + (next === "running" ? 1 : 0),
    updatedAt: now,
    ...(details.checkpointId ? { checkpointId: details.checkpointId } : {}),
    ...(details.error ? { lastError: details.error.slice(0, 1000) } : {}),
    ...(details.evidenceIds ? { evidenceIds: [...new Set([...current.evidenceIds, ...details.evidenceIds])].slice(-100) } : {}),
  };
  const steps = plan.steps.map((step, i) => i === index ? updated : step);
  const hasRunning = steps.some((step) => step.status === "running");
  const hasApproval = steps.some((step) => step.status === "waiting_approval");
  const allTerminal = steps.every((step) => ["succeeded", "skipped", "cancelled"].includes(step.status));
  const hasFailure = steps.some((step) => step.status === "failed");
  let status: WorkflowPlan["status"] = plan.status;
  if (hasApproval) status = "waiting_approval";
  else if (hasRunning || steps.some((step) => step.status === "ready")) status = "running";
  else if (allTerminal) status = steps.some((step) => step.status === "cancelled") ? "cancelled" : "completed";
  else if (hasFailure) status = "failed";
  else if (next === "ready") status = "running";
  return { ...plan, steps, status, updatedAt: now };
}

export function workflowStepDependenciesSatisfied(plan: WorkflowPlan, stepId: string): boolean {
  const step = plan.steps.find((item) => item.id === stepId);
  if (!step) throw new Error(`Unknown workflow step: ${stepId}`);
  const byId = new Map(plan.steps.map((item) => [item.id, item]));
  return step.dependsOn.every((id) => byId.get(id)?.status === "succeeded");
}

export function readyWorkflowSteps(plan: WorkflowPlan): WorkflowStepRecord[] {
  return plan.steps.filter((step) =>
    (step.status === "pending" || step.status === "ready") &&
    workflowStepDependenciesSatisfied(plan, step.id),
  );
}

/** Retries are conservative: ambiguous side effects block automatic retries. */
export function assessWorkflowRetry(input: {
  idempotent: boolean;
  sideEffectKnown?: "none" | "completed" | "unknown";
  checkpointAvailable?: boolean;
  consequential?: boolean;
}): RetryAssessment {
  if (input.sideEffectKnown === "unknown") {
    return { allowed: false, requiresApproval: true, reason: "Side effects are uncertain; inspect downstream state before retrying." };
  }
  if (input.sideEffectKnown === "completed") {
    return { allowed: false, requiresApproval: true, reason: "The action may already have completed; reconcile state instead of repeating it." };
  }
  if (!input.idempotent) {
    return { allowed: false, requiresApproval: true, reason: "The action is not known to be idempotent; automatic retry could duplicate side effects." };
  }
  if (input.consequential && !input.checkpointAvailable) {
    return { allowed: false, requiresApproval: true, reason: "A consequential retry requires a verified checkpoint and approval." };
  }
  return {
    allowed: true,
    requiresApproval: Boolean(input.consequential),
    reason: input.consequential
      ? "Idempotent retry is possible, but approval is required for this consequential action."
      : "No side effect was observed and the action is marked idempotent; retry remains bounded by the caller.",
  };
}
