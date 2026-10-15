import { randomUUID } from "node:crypto";
import type { WorkflowPlan, WorkflowStepRecord } from "./workflow-plan.js";
import { assessWorkflowRetry, readyWorkflowSteps, transitionWorkflowStep } from "./workflow-plan.js";
import type { WorkflowPlanStore } from "./workflow-plan-store.js";

export interface WorkflowStepExecutionResult {
  evidenceIds?: readonly string[];
  output?: unknown;
}

export interface WorkflowOrchestratorDependencies {
  store: WorkflowPlanStore;
  /** Must enforce tool-level authorization and validate all untrusted inputs. */
  executeStep(step: Readonly<WorkflowStepRecord>, context: { workflowId: string; signal?: AbortSignal }): Promise<WorkflowStepExecutionResult>;
  /** Create and verify a real rollback/checkpoint before a consequential action. */
  createCheckpoint?(plan: Readonly<WorkflowPlan>, step: Readonly<WorkflowStepRecord>): Promise<{ id: string; verified: boolean }>;
  /** Approval must be bound to the authenticated principal and this exact workflow/step. */
  requestApproval?(plan: Readonly<WorkflowPlan>, step: Readonly<WorkflowStepRecord>, checkpointId: string): Promise<boolean>;
  /** Optional reconciliation after a process crashed while a step was running. Never assume no side effects. */
  reconcileInterruptedStep?(plan: Readonly<WorkflowPlan>, step: Readonly<WorkflowStepRecord>): Promise<"not_started" | "completed" | "unknown">;
  maxStepsPerRun?: number;
  now?: () => string;
}

export interface WorkflowExecutionSummary {
  plan: WorkflowPlan;
  executed: number;
  waitingForApproval: boolean;
  stoppedReason?: string;
}

/**
 * Sequential durable orchestrator. It intentionally executes one step at a time.
 * The caller supplies the real tool gateway, checkpoint service and principal-bound approval UI.
 */
export class WorkflowOrchestrator {
  private readonly activeRuns = new Set<string>();
  private readonly maxStepsPerRun: number;
  private readonly now: () => string;

  constructor(private readonly deps: WorkflowOrchestratorDependencies) {
    this.maxStepsPerRun = deps.maxStepsPerRun ?? 20;
    if (!Number.isInteger(this.maxStepsPerRun) || this.maxStepsPerRun < 1 || this.maxStepsPerRun > 100) {
      throw new Error("maxStepsPerRun must be an integer between 1 and 100");
    }
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async create(plan: WorkflowPlan): Promise<WorkflowPlan> {
    if (await this.deps.store.load(plan.id)) throw new Error("Workflow plan already exists");
    await this.deps.store.save(plan);
    return plan;
  }

  async get(id: string): Promise<WorkflowPlan | undefined> {
    return this.deps.store.load(id);
  }

  async run(id: string, options: { signal?: AbortSignal } = {}): Promise<WorkflowExecutionSummary> {
    if (this.activeRuns.has(id)) {
      const plan = await this.deps.store.load(id);
      if (!plan) throw new Error("Workflow plan not found");
      return {
        plan,
        executed: 0,
        waitingForApproval: plan.status === "waiting_approval",
        stoppedReason: "This workflow is already executing in this orchestrator instance.",
      };
    }
    this.activeRuns.add(id);
    try {
      return await this.runExclusive(id, options);
    } finally {
      this.activeRuns.delete(id);
    }
  }

  private async runExclusive(id: string, options: { signal?: AbortSignal }): Promise<WorkflowExecutionSummary> {
    let plan = await this.deps.store.load(id);
    if (!plan) throw new Error("Workflow plan not found");
    if (["completed", "failed", "cancelled"].includes(plan.status)) {
      return { plan, executed: 0, waitingForApproval: false, stoppedReason: "Workflow is already terminal." };
    }
    let executed = 0;

    // A process may have died after a side effect but before persisting success. Reconcile first.
    const interrupted = plan.steps.find((step) => step.status === "running");
    if (interrupted) {
      if (!this.deps.reconcileInterruptedStep) {
        return { plan, executed, waitingForApproval: false, stoppedReason: "A step was interrupted; reconciliation is required before resuming." };
      }
      const state = await this.deps.reconcileInterruptedStep(plan, interrupted);
      if (state === "unknown") {
        return { plan, executed, waitingForApproval: false, stoppedReason: "Interrupted step side effects are unknown; automatic retry is blocked." };
      }
      if (state === "completed") {
        plan = transitionWorkflowStep(plan, interrupted.id, "succeeded", { now: this.now(), evidenceIds: ["reconciled-after-interruption"] });
      } else {
        const retry = assessWorkflowRetry({
          idempotent: interrupted.idempotent,
          sideEffectKnown: "none",
          consequential: interrupted.consequential,
          checkpointAvailable: Boolean(interrupted.checkpointId),
        });
        if (!retry.allowed || retry.requiresApproval) {
          return { plan, executed, waitingForApproval: retry.requiresApproval, stoppedReason: retry.reason };
        }
        plan = transitionWorkflowStep(plan, interrupted.id, "failed", { now: this.now(), error: "Execution interrupted before side effects; safe retry must be explicitly replanned." });
        await this.deps.store.save(plan);
        return { plan, executed, waitingForApproval: false, stoppedReason: "Interrupted step was reconciled as not started; create an explicit retry plan before continuing." };
      }
      await this.deps.store.save(plan);
    }

    while (executed < this.maxStepsPerRun) {
      if (options.signal?.aborted) {
        return { plan, executed, waitingForApproval: false, stoppedReason: "Cancellation requested; no new step was started." };
      }
      const waiting = plan.steps.find((step) => step.status === "waiting_approval");
      const candidate = waiting ?? readyWorkflowSteps(plan)[0];
      if (!candidate) {
        return {
          plan,
          executed,
          waitingForApproval: plan.status === "waiting_approval",
          ...(plan.status === "failed" ? { stoppedReason: "A step failed; repair/retry requires explicit reconciliation." } : {}),
        };
      }

      let step = candidate;
      let checkpointId: string | undefined = step.checkpointId;
      if (step.consequential) {
        if (!checkpointId) {
          if (!this.deps.createCheckpoint) {
            return { plan, executed, waitingForApproval: true, stoppedReason: "Consequential action blocked: no checkpoint service is configured." };
          }
          const checkpoint = await this.deps.createCheckpoint(plan, step);
          if (!checkpoint.verified || !checkpoint.id.trim()) {
            return { plan, executed, waitingForApproval: true, stoppedReason: "Consequential action blocked: checkpoint could not be verified." };
          }
          checkpointId = checkpoint.id;
        }
        if (!this.deps.requestApproval) {
          if (step.status !== "waiting_approval") {
            plan = transitionWorkflowStep(plan, step.id, "waiting_approval", { now: this.now(), checkpointId });
            await this.deps.store.save(plan);
          }
          return { plan, executed, waitingForApproval: true, stoppedReason: "Consequential action blocked: no approval provider is configured." };
        }
        const approved = await this.deps.requestApproval(plan, step, checkpointId);
        if (!approved) {
          if (step.status !== "waiting_approval") {
            plan = transitionWorkflowStep(plan, step.id, "waiting_approval", { now: this.now(), checkpointId });
            await this.deps.store.save(plan);
          }
          return { plan, executed, waitingForApproval: true, stoppedReason: "Waiting for explicit approval." };
        }
      }

      if (step.status === "waiting_approval") {
        plan = transitionWorkflowStep(plan, step.id, "ready", { now: this.now(), checkpointId });
        await this.deps.store.save(plan);
        step = plan.steps.find((item) => item.id === step.id)!;
      }
      if (step.status === "pending") {
        plan = transitionWorkflowStep(plan, step.id, "ready", { now: this.now() });
        await this.deps.store.save(plan);
        step = plan.steps.find((item) => item.id === step.id)!;
      }
      if (options.signal?.aborted) {
        return { plan, executed, waitingForApproval: false, stoppedReason: "Cancellation requested before step execution." };
      }

      plan = transitionWorkflowStep(plan, step.id, "running", {
        now: this.now(),
        ...(checkpointId ? { checkpointId } : {}),
        ...(step.consequential ? { approved: true } : {}),
      });
      await this.deps.store.save(plan);
      try {
        const result = await this.deps.executeStep(plan.steps.find((item) => item.id === step.id)!, {
          workflowId: plan.id,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        plan = transitionWorkflowStep(plan, step.id, "succeeded", {
          now: this.now(),
          ...(result.evidenceIds ? { evidenceIds: result.evidenceIds } : {}),
        });
        await this.deps.store.save(plan);
        executed += 1;
      } catch (error) {
        if (options.signal?.aborted) {
          plan = transitionWorkflowStep(plan, step.id, "cancelled", {
            now: this.now(),
            error: "Cancellation requested while the step was running; inspect side effects before retrying.",
          });
          await this.deps.store.save(plan);
          return { plan, executed, waitingForApproval: false, stoppedReason: "Cancellation requested; inspect any partial side effects before resuming." };
        }
        plan = transitionWorkflowStep(plan, step.id, "failed", {
          now: this.now(),
          error: error instanceof Error ? error.message : "Workflow step failed with an unknown error",
        });
        await this.deps.store.save(plan);
        return { plan, executed, waitingForApproval: false, stoppedReason: "A step failed; automatic continuation is blocked." };
      }
    }

    return { plan, executed, waitingForApproval: plan.status === "waiting_approval", stoppedReason: "Per-run step limit reached; resume explicitly to continue." };
  }
}
