import { randomUUID } from "node:crypto";
import path from "node:path";
import type { WorkflowPlan, WorkflowPlanStore, WorkflowStepRecord } from "./workflow-plan-store.js";
import { readyWorkflowSteps, transitionWorkflowStep } from "./workflow-plan.js";

export interface WorkflowExecutionContext {
  /** Host-authenticated identity; never read from step/model payloads. */
  principalId: string;
  /** Must be supplied by the trusted host workspace resolver. */
  workspaceRoot: string;
  planId: string;
  signal: AbortSignal;
  approved: boolean;
}
export type WorkflowStepExecutionResult =
  | { status: "succeeded"; evidenceIds?: string[] }
  | { status: "waiting_approval"; reason?: string };

export interface WorkflowOrchestratorDependencies {
  store: WorkflowPlanStore;
  /** Must route side effects through Brain/Tool Gateway; this layer never executes tools itself. */
  executeStep: (step: Readonly<WorkflowStepRecord>, context: WorkflowExecutionContext) => Promise<WorkflowStepExecutionResult>;
  now?: () => string;
}
export interface WorkflowExecutionSummary {
  plan: WorkflowPlan;
  pausedForApproval: boolean;
  completedSteps: number;
}

/**
 * Sequential, checkpointed workflow runner. It owns scheduling and persistence,
 * not tool execution. The host callback remains responsible for policy/approval.
 * Parallel fan-out and automatic retries are deliberately not enabled here.
 */
export class WorkflowOrchestrator {
  constructor(private readonly dependencies: WorkflowOrchestratorDependencies) {}

  async run(
    planId: string,
    context: { principalId: string; workspaceRoot: string; signal?: AbortSignal; approvedStepIds?: readonly string[] },
  ): Promise<WorkflowExecutionSummary> {
    if (typeof context.principalId !== "string" || !context.principalId.trim() || context.principalId.length > 256) {
      throw new Error("Authenticated workflow principal is required.");
    }
    if (typeof context.workspaceRoot !== "string" || !path.isAbsolute(context.workspaceRoot)) {
      throw new Error("Workspace root must come from a trusted host resolver and be absolute.");
    }
    const signal = context.signal ?? new AbortController().signal;
    const lockOwner = randomUUID();
    const acquire = this.dependencies.store.acquireRunLock;
    const release = this.dependencies.store.releaseRunLock;
    if (!acquire || !release) throw new Error("Workflow store does not support exclusive run locks.");
    if (!await acquire.call(this.dependencies.store, planId, lockOwner)) {
      throw new Error("Workflow is already running or has an unreconciled lock.");
    }

    try {
      let plan = await this.requireOwnedPlan(planId, context.principalId);
      const approved = new Set(context.approvedStepIds ?? []);
      if (approved.size > 100 || [...approved].some(id => typeof id !== "string" || id.length > 80)) {
        throw new Error("Approved workflow step IDs are invalid.");
      }
      if (["completed", "cancelled"].includes(plan.status)) {
        return this.summary(plan, false);
      }
      if (plan.status === "failed") throw new Error("Failed workflow must be explicitly repaired before rerun.");

      const approvedPending = plan.steps.find(step => step.status === "waiting_approval" && approved.has(step.id));
      if (approvedPending) {
        plan = transitionWorkflowStep(plan, approvedPending.id, "running", { now: this.now() });
        await this.dependencies.store.save(plan);
        const result = await this.execute(plan, approvedPending.id, context.principalId, context.workspaceRoot, signal, true);
        plan = result.plan;
        if (result.paused) return this.summary(plan, true);
      }

      while (true) {
        if (signal.aborted) {
          plan = await this.cancelRemaining(plan);
          await this.dependencies.store.save(plan);
          throw signal.reason ?? new Error("Workflow cancelled.");
        }
        const ready = readyWorkflowSteps(plan);
        if (ready.length === 0) break;
        const step = ready[0]!;
        if (step.status === "pending") {
          plan = transitionWorkflowStep(plan, step.id, "ready", { now: this.now() });
          await this.dependencies.store.save(plan);
        }
        plan = transitionWorkflowStep(plan, step.id, "running", { now: this.now() });
        await this.dependencies.store.save(plan);
        const result = await this.execute(plan, step.id, context.principalId, context.workspaceRoot, signal, approved.has(step.id));
        plan = result.plan;
        if (result.paused) return this.summary(plan, true);
      }

      if (signal.aborted) {
        plan = await this.cancelRemaining(plan);
        await this.dependencies.store.save(plan);
        throw signal.reason ?? new Error("Workflow cancelled.");
      }
      return this.summary(plan, false);
    } finally {
      await release.call(this.dependencies.store, planId, lockOwner);
    }
  }

  private async requireOwnedPlan(planId: string, principalId: string): Promise<WorkflowPlan> {
    const plan = await this.dependencies.store.load(planId);
    if (!plan) throw new Error("Unknown workflow plan.");
    if (!plan.ownerPrincipalId || plan.ownerPrincipalId !== principalId) {
      throw new Error("Workflow owner mismatch; access denied.");
    }
    return plan;
  }

  private async execute(
    plan: WorkflowPlan,
    stepId: string,
    principalId: string,
    workspaceRoot: string,
    signal: AbortSignal,
    approved: boolean,
  ): Promise<{ plan: WorkflowPlan; paused: boolean }> {
    const step = plan.steps.find(item => item.id === stepId);
    if (!step) throw new Error("Workflow step disappeared.");
    try {
      signal.throwIfAborted();
      const result = await this.dependencies.executeStep(
        { ...step, dependsOn: [...step.dependsOn], evidenceIds: [...step.evidenceIds] },
        { principalId, workspaceRoot, planId: plan.id, signal, approved },
      );
      signal.throwIfAborted();
      if (result.status === "waiting_approval") {
        const paused = transitionWorkflowStep(plan, stepId, "waiting_approval", {
          now: this.now(),
          error: result.reason ?? "Waiting for explicit host/user approval.",
        });
        await this.dependencies.store.save(paused);
        return { plan: paused, paused: true };
      }
      const succeeded = transitionWorkflowStep(plan, stepId, "succeeded", {
        now: this.now(),
        evidenceIds: result.evidenceIds ?? [],
      });
      await this.dependencies.store.save(succeeded);
      return { plan: succeeded, paused: false };
    } catch (error) {
      if (signal.aborted) {
        const cancelled = transitionWorkflowStep(plan, stepId, "cancelled", {
          now: this.now(),
          error: "Cancelled before a verified step result was accepted.",
        });
        const final = await this.cancelRemaining(cancelled);
        await this.dependencies.store.save(final);
        throw signal.reason ?? error;
      }
      const failed = transitionWorkflowStep(plan, stepId, "failed", {
        now: this.now(),
        error: error instanceof Error ? error.message : String(error),
      });
      await this.dependencies.store.save(failed);
      throw error;
    }
  }

  private async cancelRemaining(plan: WorkflowPlan): Promise<WorkflowPlan> {
    let current = plan;
    for (const step of [...current.steps]) {
      if (["pending", "ready", "running", "waiting_approval", "failed"].includes(step.status)) {
        current = transitionWorkflowStep(current, step.id, "cancelled", {
          now: this.now(),
          error: "Workflow cancelled; no further steps will be scheduled.",
        });
      }
    }
    return current;
  }

  private summary(plan: WorkflowPlan, pausedForApproval: boolean): WorkflowExecutionSummary {
    return {
      plan,
      pausedForApproval,
      completedSteps: plan.steps.filter(step => step.status === "succeeded").length,
    };
  }

  private now(): string {
    return (this.dependencies.now ?? (() => new Date().toISOString()))();
  }
}
