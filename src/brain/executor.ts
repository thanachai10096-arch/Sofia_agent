import { randomUUID } from "node:crypto";

import {
  digest,
  parsePlan,
  parseUnderstanding,
  planFingerprint,
  topologicalOrder,
} from "./planner.js";

import type {
  AcceptanceCriterion,
  BrainEvent,
  BrainLimits,
  BrainReasoner,
  BrainState,
  CompletionReport,
  Diagnosis,
  ExecutionPlan,
  FailureCategory,
  Observation,
  Strategy,
  TaskUnderstanding,
  ToolCall,
  ToolGateway,
  ToolResult,
  VerificationResult,
} from "./types.js";

const DEFAULT_LIMITS: BrainLimits = {
  maxSteps: 40,
  maxToolCalls: 100,
  maxReplans: 4,
  maxModelCalls: 12,
  maxTokens: 60_000,
  maxContextTokens: 16_000,
  maxOutputTokens: 2_048,
  timeoutMs: 120_000,
};

const TRANSITIONS: Record<BrainState, readonly BrainState[]> = {
  idle: ["understanding"],
  understanding: ["planning"],
  planning: ["executing"],
  executing: ["observing", "waiting_approval"],
  observing: ["executing", "verifying", "diagnosing"],
  verifying: ["waiting_approval", "diagnosing", "completed"],
  diagnosing: ["replanning"],
  replanning: ["executing"],
  waiting_approval: ["executing", "verifying"],
  completed: [],
  failed: [],
  cancelled: [],
};

const TERMINAL = new Set<BrainState>(["completed", "failed", "cancelled"]);

class Stop extends Error {}

class RecoverableFailure extends Error {
  constructor(readonly category: FailureCategory, message: string) {
    super(message);
    this.name = "RecoverableFailure";
  }
}

interface Dependencies {
  reasoner: BrainReasoner;
  tools: ToolGateway;
  allowShell?: boolean;
  allowNetwork?: boolean;
  onEvent?: (event: BrainEvent) => void;
}

export interface BrainRunInput {
  task: string;
  understanding?: unknown;
  plan?: unknown;
  acceptanceCriteria?: AcceptanceCriterion[];
  signal?: AbortSignal;
}

export interface BrainRunOptions {
  dependencies: Dependencies;
  limits?: Partial<BrainLimits>;
}

function abortable<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener("abort", aborted);
    };

    const aborted = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason ?? new Error("Aborted"));
    };

    signal.addEventListener("abort", aborted, { once: true });

    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          signal.aborted
            ? reject(signal.reason ?? new Error("Aborted"))
            : resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureCategory(error: unknown): FailureCategory {
  if (error instanceof RecoverableFailure) return error.category;

  const message = errorMessage(error).toLowerCase();

  if (message.includes("syntax")) return "syntax_error";
  if (message.includes("type error") || message.includes("typescript")) {
    return "type_error";
  }
  if (message.includes("permission") || message.includes("denied")) {
    return "permission_error";
  }
  if (message.includes("network") || message.includes("fetch") || message.includes("timeout")) {
    return "network_error";
  }
  if (message.includes("dependency") || message.includes("module not found")) {
    return "dependency_error";
  }
  if (message.includes("runtime")) return "runtime_error";
  if (message.includes("tool")) return "tool_error";
  if (message.includes("environment")) return "environment_error";

  return "unknown";
}

function preview(value: unknown, max = 2_000): {
  text: string;
  truncated: boolean;
} {
  let text: string;

  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }

  text ??= String(value);

  if (text.length <= max) {
    return { text, truncated: false };
  }

  return {
    text: text.slice(0, max),
    truncated: true,
  };
}

function ensureString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Stop(`Invalid ${label}`);
  }
  return value;
}

export class SofiaBrain {
  readonly runId = randomUUID();

  private state: BrainState = "idle";
  private started = false;
  private signal!: AbortSignal;
  private readonly limits: BrainLimits;

  private readonly usage = {
    steps: 0,
    toolCalls: 0,
    modelCalls: 0,
    reservedOrUsedTokens: 0,
    replans: 0,
  };

  private observations: Observation[] = [];
  private readonly evidenceIndex: string[] = [];
  private readonly diagnoses: Diagnosis[] = [];
  private readonly decisions: Array<{ strategy: Strategy; reason: string }> = [];

  constructor(
    private readonly dependencies: Dependencies,
    limits: Partial<BrainLimits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };

    for (const [key, value] of Object.entries(this.limits)) {
      const minimum = key === "maxReplans" ? 0 : 1;
      if (!Number.isSafeInteger(value) || value < minimum) {
        throw new Error(`Invalid limit: ${key}`);
      }
    }

    if (this.limits.maxOutputTokens >= this.limits.maxContextTokens) {
      throw new Error("Output budget must be below context capacity");
    }
  }

  private emit(event: Omit<BrainEvent, "runId">): void {
    try {
      this.dependencies.onEvent?.({ ...event, runId: this.runId });
    } catch {
      // Telemetry must never alter execution semantics.
    }
  }

  private move(next: BrainState): void {
    if (TERMINAL.has(this.state)) {
      throw new Stop("Cannot leave a terminal state");
    }

    const isFailureExit = next === "failed" || next === "cancelled";

    if (!isFailureExit && !TRANSITIONS[this.state].includes(next)) {
      throw new Stop(`Invalid transition: ${this.state} -> ${next}`);
    }

    this.state = next;
    this.emit({ type: "brain.state.changed", state: next });
  }

  private wait<T>(operation: () => Promise<T>): Promise<T> {
    return abortable(this.signal, operation);
  }

  private async io<T>(operation: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();

    if (this.usage.toolCalls >= this.limits.maxToolCalls) {
      throw new Stop("Tool-call budget exhausted");
    }

    this.usage.toolCalls += 1;
    return this.wait(operation);
  }

  private async infer(
    phase: "understand" | "plan" | "replan",
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.usage.modelCalls >= this.limits.maxModelCalls) {
      throw new Stop("Model-call budget exhausted");
    }

    const recent = this.observations.slice(-12);

    for (;;) {
      this.signal.throwIfAborted();

      const request = JSON.stringify({
        phase,
        payload,
        memory: {
          observations: recent,
          diagnoses: this.diagnoses,
          decisions: this.decisions,
        },
      });

      const prepared = await this.wait(() =>
        this.dependencies.reasoner.prepare(request, {
          signal: this.signal,
          maxContextTokens: this.limits.maxContextTokens,
        }),
      );

      if (!Number.isSafeInteger(prepared.inputTokens) || prepared.inputTokens < 1) {
        throw new Stop("Invalid inference token estimate");
      }

      const reservation = prepared.inputTokens + this.limits.maxOutputTokens;

      if (reservation > this.limits.maxContextTokens) {
        if (recent.length === 0) {
          throw new Stop("Required context exceeds capacity");
        }
        recent.shift();
        continue;
      }

      // TokenBudget inside the reasoner/gateway is authoritative for
      // reservation, pricing, concurrency, and provider overruns.
      // Brain keeps only telemetry here to avoid double-reserving tokens.
      this.usage.modelCalls += 1;

      const result = await this.wait(() =>
        prepared.invoke({
          signal: this.signal,
          maxOutputTokens: this.limits.maxOutputTokens,
        }),
      );

      const actual = result.usage.inputTokens + result.usage.outputTokens;

      if (
        !Number.isSafeInteger(result.usage.inputTokens) ||
        !Number.isSafeInteger(result.usage.outputTokens) ||
        result.usage.inputTokens < 0 ||
        result.usage.outputTokens < 0
      ) {
        throw new Stop("Invalid inference usage");
      }

      this.usage.reservedOrUsedTokens += actual;

      if (this.usage.reservedOrUsedTokens > this.limits.maxTokens) {
        throw new Stop("Token budget exhausted");
      }

      return result.value;
    }
  }

  private validatePlan(plan: ExecutionPlan): ExecutionPlan {
    topologicalOrder(plan);

    if (plan.steps.length > this.limits.maxSteps) {
      throw new Stop("Plan step budget exceeded");
    }

    for (const step of plan.steps) {
      const descriptor = this.dependencies.tools.describe(step.call.tool);

      if (!descriptor) {
        throw new RecoverableFailure(
          "tool_error",
          `Unknown or unavailable tool: ${step.call.tool}`,
        );
      }

      if (
        descriptor.effects.includes("shell") &&
        this.dependencies.allowShell === false
      ) {
        throw new RecoverableFailure(
          "permission_error",
          `Shell execution is disabled: ${step.call.tool}`,
        );
      }

      if (
        descriptor.effects.includes("network") &&
        this.dependencies.allowNetwork === false
      ) {
        throw new RecoverableFailure(
          "network_error",
          `Network access is disabled: ${step.call.tool}`,
        );
      }
    }

    return plan;
  }

  private async understand(input: BrainRunInput): Promise<TaskUnderstanding> {
    if (input.understanding !== undefined) {
      return parseUnderstanding(input.understanding);
    }

    const value = await this.infer("understand", {
      task: input.task,
    });

    return parseUnderstanding(value);
  }

  private async plan(
    input: BrainRunInput,
    understanding: TaskUnderstanding,
  ): Promise<ExecutionPlan> {
    if (input.plan !== undefined) {
      return this.validatePlan(
        parsePlan(input.plan, this.limits.maxSteps),
      );
    }

    const value = await this.infer("plan", {
      task: input.task,
      understanding,
    });

    return this.validatePlan(
      parsePlan(value, this.limits.maxSteps),
    );
  }

  private async executeStep(step: ExecutionPlan["steps"][number]): Promise<Observation> {
    this.signal.throwIfAborted();

    if (this.usage.steps >= this.limits.maxSteps) {
      throw new Stop("Step budget exhausted");
    }

    this.usage.steps += 1;

    this.emit({
      type: "brain.step.started",
      stepId: step.id,
      count: this.usage.steps,
    });

    const descriptor = this.dependencies.tools.describe(step.call.tool);
    if (!descriptor) {
      throw new RecoverableFailure(
        "tool_error",
        `Unknown tool: ${step.call.tool}`,
      );
    }

    this.emit({
      type: "brain.tool.started",
      stepId: step.id,
    });

    let result: ToolResult;

    try {
      result = await this.io(() =>
        this.dependencies.tools.execute(step.call, {
          runId: this.runId,
          signal: this.signal,
          requireApproval:
            descriptor.effects.includes("destructive") ||
            descriptor.effects.includes("write") ||
            descriptor.effects.includes("shell"),
          notifyApproval: (waiting) => {
            if (waiting) {
              if (this.state === "executing") {
                this.move("waiting_approval");
              }
            } else if (this.state === "waiting_approval") {
              this.move("executing");
            }
          },
        }),
      );
    } catch (error) {
      if (this.signal.aborted) throw error;
      throw new RecoverableFailure(failureCategory(error), errorMessage(error));
    }

    const p = preview(result.data);
    const observation: Observation = {
      stepId: step.id,
      tool: step.call.tool,
      ok: result.ok,
      evidenceId: result.evidenceId,
      preview: p.text,
      truncated: p.truncated,
    };

    this.observations.push(observation);
    this.evidenceIndex.push(result.evidenceId);

    this.emit({
      type: result.ok ? "brain.tool.completed" : "brain.tool.failed",
      stepId: step.id,
    });

    this.emit({
      type: "brain.observation.created",
      stepId: step.id,
    });

    if (!result.ok) {
      throw new RecoverableFailure(
        result.error?.category ?? "tool_error",
        result.error?.message ?? "Tool execution failed",
      );
    }

    return observation;
  }

  private async verify(
    criteria: readonly AcceptanceCriterion[],
  ): Promise<VerificationResult[]> {
    this.move("verifying");
    this.emit({ type: "brain.verification.started" });

    const snapshot = await this.io(() =>
      this.dependencies.tools.snapshot(this.signal),
    );

    const results: VerificationResult[] = [];

    for (const criterion of criteria) {
      this.signal.throwIfAborted();

      const result = await this.io(() =>
        this.dependencies.tools.execute(criterion.probe, {
          runId: this.runId,
          signal: this.signal,
          requireApproval: false,
          notifyApproval: () => {
            throw new Stop("Verification probes cannot request approval");
          },
        }),
      );

      if (!result.evidenceId) {
        throw new Stop(`Verification probe returned no evidence: ${criterion.id}`);
      }

      const evaluated = criterion.evaluate(result.data);

      results.push({
        criterionId: criterion.id,
        passed: evaluated.passed && result.ok,
        detail: result.ok
          ? evaluated.detail
          : result.error?.message ?? "Verification probe failed",
        evidenceIds: [result.evidenceId],
        workspaceRevision: snapshot.revision,
      });

      if (!(evaluated.passed && result.ok)) {
        this.emit({
          type: "brain.verification.completed",
          passed: false,
        });
        return results;
      }
    }

    this.emit({ type: "brain.verification.completed", passed: true });
    return results;
  }

  private diagnose(error: unknown): Diagnosis {
    const category = failureCategory(error);
    const message = errorMessage(error);

    const fingerprint = digest({
      category,
      message: message
        .toLowerCase()
        .replace(/\b0x[a-f0-9]+\b/g, "0x?")
        .replace(/\b\d+\b/g, "#")
        .replace(/\s+/g, " ")
        .trim(),
      recent: this.observations.slice(-3).map((item) => ({
        stepId: item.stepId,
        tool: item.tool,
      })),
    });

    const repeated =
      this.diagnoses.filter((item) => item.fingerprint === fingerprint).length + 1;

    const attemptedStrategies = [
      ...new Set(this.decisions.map((decision) => decision.strategy)),
    ];

    const diagnosis: Diagnosis = {
      category,
      fingerprint,
      repeated,
      message,
      attemptedStrategies,
    };

    this.diagnoses.push(diagnosis);

    this.emit({
      type: "brain.diagnosis.created",
      category,
      count: repeated,
    });

    return diagnosis;
  }

  private async replan(
    task: string,
    understanding: TaskUnderstanding,
    previousPlan: ExecutionPlan,
    diagnosis: Diagnosis,
  ): Promise<ExecutionPlan> {
    if (this.usage.replans >= this.limits.maxReplans) {
      throw new Stop("Replan budget exhausted");
    }

    this.usage.replans += 1;
    this.move("replanning");

    const strategy: Strategy =
      diagnosis.category === "environment_error" ||
      diagnosis.category === "dependency_error"
        ? "fix-environment"
        : diagnosis.attemptedStrategies.includes("fix-implementation")
          ? "alternative-tool"
          : "fix-implementation";

    const reason = `Replanning after ${diagnosis.category}: ${diagnosis.message}`;

    this.decisions.push({ strategy, reason });

    this.emit({
      type: "brain.replan.started",
      count: this.usage.replans,
    });

    const value = await this.infer("replan", {
      task,
      understanding,
      previousPlan,
      diagnosis,
      strategy,
    });

    const plan = this.validatePlan(
      parsePlan(value, this.limits.maxSteps),
    );

    const previousFingerprint = planFingerprint(previousPlan);
    const nextFingerprint = planFingerprint(plan);

    if (previousFingerprint === nextFingerprint) {
      throw new Stop("Replanner returned the same effective plan");
    }

    return plan;
  }

  private report(
    completed: boolean,
    summary: string,
    verification: VerificationResult[],
    changedFiles: string[],
    changedFilesKnown: boolean,
    remainingRisks: string[],
  ): CompletionReport {
    return {
      completed,
      state: this.state,
      summary,
      changedFiles,
      changedFilesKnown,
      verification,
      remainingRisks,
      usage: { ...this.usage },
    };
  }

  async run(input: BrainRunInput): Promise<CompletionReport> {
    if (this.started) {
      throw new Error("Brain instances are single-use");
    }

    this.started = true;
    const requestedSignal = input.signal ?? new AbortController().signal;
    requestedSignal.throwIfAborted();
    this.signal = requestedSignal;

    const timeoutController = new AbortController();
    const onAbort = () => timeoutController.abort(this.signal.reason);
    this.signal.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(
      () => timeoutController.abort(new Error("Brain execution timed out")),
      this.limits.timeoutMs,
    );

    const signal = timeoutController.signal;
    const originalSignal = this.signal;
    this.signal = signal;

    let baselineId: string | undefined;
    let verification: VerificationResult[] = [];
    let currentPlan: ExecutionPlan | undefined;

    try {
      this.emit({ type: "brain.started", state: "idle" });
      this.move("understanding");

      const understanding = await this.understand(input);

      this.emit({
        type: "brain.understanding.completed",
      });

      this.move("planning");
      currentPlan = await this.plan(input, understanding);

      this.decisions.push({
        strategy: currentPlan.strategy,
        reason: currentPlan.reason,
      });

      this.emit({ type: "brain.plan.created" });

      baselineId = (
        await this.io(() => this.dependencies.tools.snapshot(this.signal))
      ).id;

      let completed = false;

      while (!completed) {
        this.signal.throwIfAborted();

        this.move("executing");
        const ordered = topologicalOrder(currentPlan);

        const done = new Set<string>();

        try {
          for (const step of ordered) {
            for (const dependency of step.dependencies) {
              if (!done.has(dependency)) {
                throw new Stop(
                  `Dependency was not executed: ${dependency}`,
                );
              }
            }

            await this.executeStep(step);
            done.add(step.id);
          }

          this.move("observing");

          const criteria = input.acceptanceCriteria ?? [];
          if (criteria.length === 0) {
            throw new RecoverableFailure(
              "incomplete_solution",
              "No trusted acceptance criteria were provided.",
            );
          }

          verification = await this.verify(criteria);

          if (verification.every((item) => item.passed)) {
            this.move("completed");
            completed = true;
            break;
          }

          throw new RecoverableFailure(
            "incomplete_solution",
            verification
              .filter((item) => !item.passed)
              .map((item) => item.detail)
              .join("; ") || "Acceptance criteria failed",
          );
        } catch (error) {
          if (this.signal.aborted) throw error;
          if (error instanceof Stop) throw error;

          this.move("diagnosing");
          const diagnosis = this.diagnose(error);

          if (diagnosis.repeated > 1) {
            throw new Stop(
              `Repeated failure detected: ${diagnosis.fingerprint}`,
            );
          }

          currentPlan = await this.replan(
            input.task,
            understanding,
            currentPlan,
            diagnosis,
          );
        }
      }

      const changedFiles = baselineId
        ? await this.io(() =>
            this.dependencies.tools.changedFiles(
              baselineId!,
              this.signal,
            ),
          )
        : [];

      const summary =
        verification.length > 0
          ? "Task completed and all acceptance criteria passed."
          : "Task completed.";

      return this.report(
        true,
        summary,
        verification,
        changedFiles,
        true,
        [],
      );
    } catch (error) {
      const aborted = signal.aborted;
      const message = errorMessage(error);

      if (aborted) {
        this.state = "cancelled";
        this.emit({
          type: "brain.cancelled",
          state: "cancelled",
        });
        return this.report(
          false,
          `Brain execution cancelled: ${message}`,
          verification,
          [],
          false,
          [message],
        );
      }

      this.state = "failed";
      this.emit({
        type: "brain.failed",
        state: "failed",
      });

      return this.report(
        false,
        `Brain execution failed: ${message}`,
        verification,
        [],
        false,
        [message],
      );
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener("abort", onAbort);
      this.signal = originalSignal;
    }
  }
}

export function createSofiaBrain(
  options: BrainRunOptions,
): SofiaBrain {
  return new SofiaBrain(options.dependencies, options.limits);
}

export type { Dependencies as SofiaBrainDependencies };
