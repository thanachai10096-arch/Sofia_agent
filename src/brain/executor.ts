import { fenceUntrustedOutput } from "../security/untrusted.js";
import { randomUUID } from "node:crypto";

import {
  digest,
  parsePlan,
  parseUnderstanding,
  planFingerprint,
  topologicalOrder,
} from "./planner.js";

import { runVerification } from "./verification.js";
import { diagnosisFromFailure, failureEvidenceFromVerification, preferredStrategy } from "./failure-analysis.js";
import { compactSkillContext, matchSkills } from "./skills.js";
import type { SkillLedger } from "./learning.js";
import { compactProjectContext, type ProjectContext } from "./project-context.js";
import { roleForTask, type SubagentRuntime, type SubagentResult } from "./subagents.js";
import { AgentMessageBus, createAgentMessage, type AgentIdentity, type AgentRole, type AgentTaskScope } from "../agents/protocol.js";
import { DelegationAuthorizer } from "../security/delegation-policy.js";
import { ExecutionTrace, type ExecutionTraceEntry } from "./execution-trace.js";
import type { BrainRunSnapshot } from "./run-state.js";
import type { RepositoryMap } from "./repository-intelligence.js";
import { compactRepositoryMap } from "./repository-intelligence.js";
import { reviewCodeChange } from "../review/code-review.js";
import type { RunStore } from "./run-store.js";
import type { ProjectMemoryEntry, ProjectMemoryStore } from "./project-memory.js";
import type { EvolutionEngine } from "./evolution.js";

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
  executing: ["observing", "waiting_approval", "diagnosing"],
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
  skillLedger?: SkillLedger;
  projectContext?: ProjectContext;
  projectContextLoader?: () => Promise<ProjectContext>;
  repositoryMap?: RepositoryMap;
  repositoryMapLoader?: (task: string) => Promise<RepositoryMap>;
  subagents?: SubagentRuntime;
  onRunSnapshot?: (snapshot: BrainRunSnapshot) => void | Promise<void>;
  runStore?: RunStore;
  projectMemory?: ProjectMemoryStore;
  evolution?: EvolutionEngine;
}

export interface BrainRunInput {
  task: string;
  principalId?: string;
  understanding?: unknown;
  plan?: unknown;
  acceptanceCriteria?: AcceptanceCriterion[];
  signal?: AbortSignal;
  rollbackOnFailure?: boolean;
  resume?: BrainRunSnapshot;
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateSubagentResult(value: unknown, expectedRole: SubagentResult["role"]): SubagentResult {
  if (!isPlainRecord(value) || value.role !== expectedRole ||
      typeof value.summary !== "string" || !value.summary.trim()) {
    throw new RecoverableFailure("tool_error", "Specialist returned an invalid result envelope");
  }

  let proposedAction: SubagentResult["proposedAction"];
  if (value.proposedAction !== undefined) {
    const proposal = value.proposedAction;
    if (!isPlainRecord(proposal) ||
        typeof proposal.tool !== "string" || !proposal.tool.trim() || proposal.tool.length > 128 ||
        !isPlainRecord(proposal.input) ||
        typeof proposal.reason !== "string" || !proposal.reason.trim() || proposal.reason.length > 1000) {
      throw new RecoverableFailure("tool_error", "Specialist returned a malformed action proposal");
    }
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify({ tool: proposal.tool, input: proposal.input, reason: proposal.reason }), "utf8");
    } catch {
      throw new RecoverableFailure("tool_error", "Specialist action proposal is not serializable");
    }
    if (bytes > 16 * 1024) {
      throw new RecoverableFailure("tool_error", "Specialist action proposal exceeds the size limit");
    }
    proposedAction = {
      tool: proposal.tool,
      input: proposal.input,
      reason: proposal.reason,
    };
  }

  // Do not retain arbitrary model output in the Brain recovery state. Only the
  // bounded summary and a separately validated proposal are needed downstream.
  return {
    role: expectedRole,
    summary: value.summary.slice(0, 6_000),
    output: undefined,
    ...(proposedAction ? { proposedAction } : {}),
  };
}

export class SofiaBrain {
  readonly runId = randomUUID();

  private state: BrainState = "idle";
  private started = false;
  private signal!: AbortSignal;
  private readonly limits: BrainLimits;
  private readonly trace = new ExecutionTrace();

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
  private projectContext?: ProjectContext;
  private repositoryMap?: RepositoryMap;
  private projectContextLoaded = false;
  private projectMemory: ProjectMemoryEntry[] = [];
  private projectMemoryLoaded = false;
  private readonly selectedSkillIds = new Set<string>();
  private activeSkillId?: string;

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
    const fullEvent = { ...event, runId: this.runId };
    this.trace.append(fullEvent);
    try {
      this.dependencies.onEvent?.(fullEvent);
    } catch {
      // Telemetry must never alter execution semantics.
    }
  }

  getExecutionTrace(): ExecutionTraceEntry[] {
    return this.trace.snapshot();
  }

  getRunSnapshot(): BrainRunSnapshot | undefined {
    return this.latestRunSnapshot;
  }

  private latestRunSnapshot?: BrainRunSnapshot;

  private async saveRunSnapshot(snapshot: BrainRunSnapshot): Promise<void> {
    this.latestRunSnapshot = snapshot;
    this.emit({ type: "brain.run.checkpointed" });
    try {
      await this.dependencies.runStore?.save(snapshot);
      await this.dependencies.onRunSnapshot?.(snapshot);
    } catch {
      // Persistence must never alter execution semantics.
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
    phase: "understand" | "plan" | "replan" | "subagent",
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.usage.modelCalls >= this.limits.maxModelCalls) {
      throw new Stop("Model-call budget exhausted");
    }

    const recent = this.observations.slice(-12);
    if (!this.projectContextLoaded) {
      this.projectContextLoaded = true;
      if (this.dependencies.projectContextLoader) this.projectContext = await this.wait(this.dependencies.projectContextLoader);
      else this.projectContext = this.dependencies.projectContext;
      if (this.dependencies.projectMemory && this.projectContext) {
        const instructionFiles = new Set(["SOFIA.md", "Sofia.md", "AGENTS.md", "CLAUDE.md"]);
        for (const file of this.projectContext.files) {
          if (!instructionFiles.has(file.path)) continue;
          const now = new Date().toISOString();
          const id = "convention:" + this.projectContext.root + ":" + file.path;
          const entry: ProjectMemoryEntry = { id, project: this.projectContext.root, kind: "convention", content: file.content.slice(0, 4000), source: file.path, confidence: 0.95, createdAt: now, updatedAt: now, uses: 0 };
          try { await this.wait(() => this.dependencies.projectMemory!.save(entry)); }
          catch { /* Memory persistence is best-effort. */ }
        }
      }
    }

    if (!this.projectMemoryLoaded && this.dependencies.projectMemory) {
      this.projectMemoryLoaded = true;
      try { this.projectMemory = await this.wait(() => this.dependencies.projectMemory!.list()); }
      catch { this.projectMemory = []; }
    }

    for (;;) {
      this.signal.throwIfAborted();

      const request = JSON.stringify({
        phase,
        payload,
        memory: {
          observations: recent,
          diagnoses: this.diagnoses,
          decisions: this.decisions,
          projectContext: this.projectContext ? compactProjectContext(this.projectContext) : undefined,
          projectMemory: this.projectMemory.slice(-12).map((entry) => ({ kind: entry.kind, content: entry.content, confidence: entry.confidence, source: entry.source })),
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

      const estimatedContext = prepared.inputTokens + this.limits.maxOutputTokens;

      if (estimatedContext > this.limits.maxContextTokens) {
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
      availableTools: this.dependencies.tools.listTools?.() ?? [],
      repository: this.repositoryMap ? compactRepositoryMap(this.repositoryMap) : undefined,
    });

    return parseUnderstanding(value);
  }

  private async delegateSubagent(
    task: string,
    context: Record<string, unknown>,
    failureCategory?: string,
  ): Promise<SubagentResult | undefined> {
    const runtime = this.dependencies.subagents;
    if (!runtime) return undefined;

    if (this.usage.modelCalls >= this.limits.maxModelCalls) {
      throw new Stop("Model-call budget exhausted");
    }

    this.usage.modelCalls += 1;
    const role = roleForTask(task, failureCategory);
    // Bind this one specialist round-trip to host-owned run identity and scope.
    // Coordination grants no tools: any returned proposal must still pass the
    // existing Brain allowlist, Tool Gateway policy, and normal approval flow.
    const specialistRole: AgentRole = role === "explorer" || role === "researcher"
      ? "researcher"
      : role === "architect"
        ? "planner"
        : role === "debugger"
          ? "specialist"
          : role;
    const orchestratorId = `brain:${this.runId}`;
    const specialistId = `specialist:${this.runId}`;
    const identities = new Map<string, AgentIdentity>([
      [orchestratorId, { id: orchestratorId, role: "orchestrator", capabilities: [] }],
      [specialistId, { id: specialistId, role: specialistRole, capabilities: [] }],
    ]);
    const scope: AgentTaskScope = {
      jobId: this.runId,
      objective: task.slice(0, 4_000),
      allowedTools: [],
      maxHops: 1,
      deadlineEpochMs: Date.now() + this.limits.timeoutMs,
    };
    const bus = new AgentMessageBus(scope, identities);
    const authorizer = new DelegationAuthorizer(identities, scope);
    try {
      const decision = authorizer.authorize({
        requesterId: orchestratorId,
        recipientId: specialistId,
        jobId: this.runId,
        requestedTools: [],
        hop: 0,
        purpose: `Bounded failure recovery: ${task.slice(0, 900)}`,
      });
      if (!decision.allowed) {
        throw new RecoverableFailure("permission_error", "Specialist delegation denied by host policy");
      }

      bus.publish(createAgentMessage({
        correlationId: this.runId,
        jobId: this.runId,
        from: orchestratorId,
        to: specialistId,
        kind: "task",
        payload: { role, task, context },
      }));
      const taskMessage = bus.takeFor(specialistId);
      if (!taskMessage || taskMessage.kind !== "task") {
        throw new RecoverableFailure("tool_error", "Specialist task message was unavailable");
      }
      const result: unknown = await this.wait(() =>
        runtime.run({
          role,
          task,
          context,
          signal: this.signal,
        }),
      );

      // The result is still untrusted data. The message bus bounds it, and the
      // Brain validates its schema and role before considering any proposal.
      bus.publish(createAgentMessage({
        correlationId: this.runId,
        jobId: this.runId,
        from: specialistId,
        to: orchestratorId,
        kind: "result",
        payload: { result },
      }));
      const resultMessage = bus.takeFor(orchestratorId);
      if (!resultMessage || resultMessage.kind !== "result" ||
          !resultMessage.payload || typeof resultMessage.payload !== "object" ||
          !("result" in resultMessage.payload)) {
        throw new RecoverableFailure("tool_error", "Specialist result message was invalid");
      }

      const validated = validateSubagentResult(resultMessage.payload.result, role);
      this.emit({ type: "brain.subagent.completed" });
      return validated;
    } finally {
      // Per-run queues never outlive the active Brain run.
      bus.close();
    }
  }

  private async applySubagentProposal(proposal: { tool: string; input: Record<string, unknown>; reason: string }, principalId?: string): Promise<void> {
    const descriptor = this.dependencies.tools.describe(proposal.tool);
    if (!descriptor) throw new RecoverableFailure("tool_error", "Unknown delegated tool");
    const permitted = new Set([
      "workspace.read_file",
      "workspace.list_files",
      "workspace.search",
      "git.diff",
      "project.verify",
      "workspace.write_file",
      "workspace.apply_patch",
    ]);
    if (!permitted.has(proposal.tool)) {
      throw new RecoverableFailure("tool_error", "Delegated tool is outside Brain scope");
    }
    await this.executeStep({
      id: "delegated-" + this.usage.steps,
      objective: proposal.reason,
      dependencies: [],
      call: { tool: proposal.tool, input: proposal.input },
    }, principalId);
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
      availableTools: this.dependencies.tools.listTools?.() ?? [],
      repository: this.repositoryMap ? compactRepositoryMap(this.repositoryMap) : undefined,
    });

    return this.validatePlan(
      parsePlan(value, this.limits.maxSteps),
    );
  }

  private async executeStep(step: ExecutionPlan["steps"][number], principalId?: string): Promise<Observation> {
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
          ...(principalId ? { principalId } : {}),
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
    const fenced = fenceUntrustedOutput(step.call.tool, p.text);
    const observation: Observation = {
      stepId: step.id, tool: step.call.tool, ok: result.ok, evidenceId: result.evidenceId,
      preview: fenced.text, truncated: p.truncated,
      ...(fenced.suspicious ? { suspicious: true } : {}),
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
    principalId?: string,
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
          ...(principalId ? { principalId } : {}),
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
    const diagnosis = diagnosisFromFailure(
      { category, message, source: "tool", files: this.observations.slice(-6).map((item) => item.tool) },
      this.diagnoses,
    );
    diagnosis.attemptedStrategies = [
      ...new Set(this.decisions.map((decision) => decision.strategy)),
    ];
    this.diagnoses.push(diagnosis);
    this.emit({ type: "brain.diagnosis.created", category: diagnosis.category, count: diagnosis.repeated });
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

    const strategy: Strategy = preferredStrategy(diagnosis.category, diagnosis.attemptedStrategies);

    const reason = `Replanning after ${diagnosis.category}: ${diagnosis.message}`;

    this.decisions.push({ strategy, reason });

    this.emit({
      type: "brain.replan.started",
      count: this.usage.replans,
    });

    const taskType = understanding.requiredCapabilities[0] ?? "general";
    let skills = matchSkills(diagnosis.category, diagnosis.message, 5, this.dependencies.skillLedger);
    if (this.dependencies.evolution) {
      const ranking = new Map(this.dependencies.evolution.rank(skills.map(skill => skill.id), taskType).map(item => [item.id, item.score]));
      skills = [...skills].sort((a, b) => (ranking.get(b.id) ?? 0) - (ranking.get(a.id) ?? 0));
    }
    if (skills[0]) {
      this.selectedSkillIds.add(skills[0].id);
      this.activeSkillId = skills[0].id;
    }
    const value = await this.infer("replan", {
      task,
      understanding,
      previousPlan,
      diagnosis,
      strategy,
      matchedSkills: compactSkillContext(skills),
      repository: this.repositoryMap ? compactRepositoryMap(this.repositoryMap) : undefined,
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
    let checkpointId: string | undefined;
    let verification: VerificationResult[] = [];
    let currentPlan: ExecutionPlan | undefined;
    let recoveryRounds = 0;
    const recoveryFingerprints = new Set<string>();
    const resumed = input.resume;
    let understanding: TaskUnderstanding | undefined;
    let completedStepIds = new Set<string>();

    const checkpointState = async (plan: ExecutionPlan | undefined): Promise<void> => {
      if (!plan || !checkpointId || !understanding) return;
      await this.saveRunSnapshot({
        version: 1,
        runId: this.runId,
        task: input.task,
        understanding,
        plan,
        acceptanceCriteria: input.acceptanceCriteria ?? [],
        completedStepIds: [...completedStepIds],
        checkpointId,
        baselineSnapshotId: baselineId,
        usage: { ...this.usage },
        observations: [...this.observations],
        diagnoses: [...this.diagnoses],
        decisions: [...this.decisions],
        recoveryRounds,
        trace: this.trace.snapshot(),
      });
    };

    try {
      this.emit({ type: "brain.started", state: "idle" });

      if (resumed) {
        if (resumed.version !== 1) throw new Stop("Unsupported run snapshot version");
        if (resumed.task !== input.task) throw new Stop("Run snapshot task mismatch");
        understanding = resumed.understanding;
        currentPlan = this.validatePlan(resumed.plan);
        checkpointId = resumed.checkpointId;
        baselineId = resumed.baselineSnapshotId;
        completedStepIds = new Set(resumed.completedStepIds);
        this.observations = [...resumed.observations];
        this.diagnoses.push(...resumed.diagnoses);
        this.decisions.push(...resumed.decisions);
        recoveryRounds = resumed.recoveryRounds;
        this.usage.steps = resumed.usage.steps;
        this.usage.toolCalls = resumed.usage.toolCalls;
        this.usage.modelCalls = resumed.usage.modelCalls;
        this.usage.reservedOrUsedTokens = resumed.usage.reservedOrUsedTokens;
        this.usage.replans = resumed.usage.replans;
        this.state = "planning";
        this.emit({ type: "brain.run.resumed" });
        this.emit({ type: "brain.state.changed", state: "planning" });
      } else {
        this.move("understanding");
        understanding = await this.understand(input);

        this.emit({
          type: "brain.understanding.completed",
        });

        baselineId = (
          await this.io(() => this.dependencies.tools.snapshot(this.signal))
        ).id;
        checkpointId = (
          await this.io(() => this.dependencies.tools.checkpoint(this.signal))
        ).id;
        this.emit({ type: "brain.checkpoint.created" });

        this.move("planning");
        currentPlan = await this.plan(input, understanding);

        this.decisions.push({
          strategy: currentPlan.strategy,
          reason: currentPlan.reason,
        });

        this.emit({ type: "brain.plan.created" });
      }

      if (!understanding || !currentPlan) throw new Stop("Run state is incomplete");
      await checkpointState(currentPlan);

      let completed = false;
      let codingIteration = 0;
      this.emit({ type: "brain.coding.loop.started", count: 0 });

      while (!completed) {
        codingIteration += 1;
        this.emit({ type: "brain.coding.loop.iteration", count: codingIteration });
        if (codingIteration > this.limits.maxReplans + 2) {
          throw new Stop("Coding loop iteration budget exhausted");
        }
        this.signal.throwIfAborted();

        this.move("executing");
        const ordered = topologicalOrder(currentPlan);

        const done = new Set<string>();

        try {
          for (const step of ordered) {
            if (completedStepIds.has(step.id)) {
              done.add(step.id);
              continue;
            }

            for (const dependency of step.dependencies) {
              if (!done.has(dependency)) {
                throw new Stop(
                  `Dependency was not executed: ${dependency}`,
                );
              }
            }

            await this.executeStep(step, input.principalId);
            done.add(step.id);
            completedStepIds.add(step.id);
            await checkpointState(currentPlan);
          }

          this.move("observing");

          const criteria = input.acceptanceCriteria ?? [];
          if (criteria.length === 0) {
            this.move("verifying");
            this.emit({ type: "brain.verification.started" });
            // A coding task gets a bounded trusted verification pipeline by default.
            // Custom acceptance criteria still take precedence for domain-specific work.
            verification = await runVerification(
              this.dependencies.tools,
              ["typecheck", "test", "build"],
              this.signal,
              this.runId,
            );
            this.emit({
              type: "brain.verification.completed",
              passed: verification.every((item) => item.passed),
            });
            this.emit({
              type: "brain.coding.loop.verification",
              count: codingIteration,
              passed: verification.every((item) => item.passed),
            });
          } else {
            verification = await this.verify(criteria, input.principalId);
          }

          if (verification.every((item) => item.passed)) {
            const changedFiles = baselineId
              ? await this.io(() =>
                  this.dependencies.tools.changedFiles(baselineId!, this.signal),
                )
              : [];
            const diffResult = await this.io(() =>
              this.dependencies.tools.execute(
                { tool: "git.diff", input: {} },
                {
                  runId: this.runId,
                  signal: this.signal,
                  requireApproval: false,
                  notifyApproval: () => {},
                },
              ),
            );
            const diff =
              diffResult.ok && diffResult.data
                ? JSON.stringify(diffResult.data)
                : undefined;
            const review = reviewCodeChange({
              task: input.task,
              changedFiles,
              verification,
              diff,
              acceptanceCriteria: (input.acceptanceCriteria ?? []).map(
                (criterion) => criterion.description,
              ),
            });
            this.emit({
              type: "brain.review.completed",
              passed: review.approved,
              count: codingIteration,
            });
            if (!review.approved) {
              throw new RecoverableFailure(
                review.repairCategory ?? "incomplete_solution",
                review.reason,
              );
            }

            this.move("completed");
            completed = true;
            break;
          }

          const failure = failureEvidenceFromVerification(verification);
          this.emit({ type: "brain.coding.loop.repair_needed", count: codingIteration, passed: false });
          throw new RecoverableFailure(
            failure?.category ?? "incomplete_solution",
            failure?.message ?? "Acceptance criteria failed",
          );
        } catch (error) {
          if (this.signal.aborted) throw error;
          if (error instanceof Stop) throw error;

          this.move("diagnosing");
          const diagnosis = this.diagnose(error);
          if (this.dependencies.evolution && this.activeSkillId) {
            // Penalize only the skill that actually informed the previous repair plan,
            // never every candidate that merely matched the error text. A failed skill
            // is not also credited when a different repair later succeeds.
            this.dependencies.evolution.recordFailure(
              this.activeSkillId,
              diagnosis.message,
              understanding?.requiredCapabilities[0] ?? "general",
            );
            this.selectedSkillIds.delete(this.activeSkillId);
            this.activeSkillId = undefined;
          }

          const specialist = recoveryRounds === 0 ? await this.delegateSubagent(
            input.task,
            {
              phase: "failure-recovery",
              understanding,
              diagnosis,
              observations: this.observations.slice(-8),
              previousPlan: currentPlan,
              projectContext: this.projectContext
                ? compactProjectContext(this.projectContext)
                : undefined,
            },
            diagnosis.category,
          ) : undefined;

          if (specialist?.proposedAction) {
            recoveryRounds += 1;
            if (recoveryRounds > this.limits.maxReplans + 1) {
              throw new Stop("Recovery round budget exhausted");
            }

            if (recoveryFingerprints.has(diagnosis.fingerprint)) {
              throw new Stop(
                `Recovery repeated the same failure: ${diagnosis.fingerprint}`,
              );
            }
            recoveryFingerprints.add(diagnosis.fingerprint);

            // Recovery actions still flow through the Brain state machine and
            // the main ToolGateway. After the specialist proposes a repair,
            // verify it immediately instead of paying for an unnecessary plan.
            this.move("replanning");
            this.move("executing");
            await this.applySubagentProposal(specialist.proposedAction, input.principalId);
            this.move("observing");

            this.emit({ type: "brain.coding.loop.repaired", count: recoveryRounds });
            completedStepIds = new Set(currentPlan.steps.map((step) => step.id));
            await checkpointState(currentPlan);
            continue;
          }

          if (diagnosis.repeated > 1) {
            throw new Stop(
              `Repeated failure detected: ${diagnosis.fingerprint}`,
            );
          }

          const previousStepFingerprints = new Map(
            currentPlan.steps.map((step) => [step.id, digest(step)]),
          );
          currentPlan = await this.replan(
            input.task,
            understanding,
            currentPlan,
            diagnosis,
          );
          const nextStepFingerprints = new Map(
            currentPlan.steps.map((step) => [step.id, digest(step)]),
          );
          // A planner may reuse a step ID for a different action. Only preserve
          // completion when the full step definition is unchanged across replans.
          completedStepIds = new Set(
            [...completedStepIds].filter((id) =>
              previousStepFingerprints.has(id) &&
              previousStepFingerprints.get(id) === nextStepFingerprints.get(id),
            ),
          );
        }
      }

      this.emit({ type: "brain.coding.loop.completed", count: codingIteration, passed: true });
      if (this.dependencies.evolution) {
        const taskType = understanding.requiredCapabilities[0] ?? "general";
        // This block is reachable only after trusted verification and code review pass.
        for (const skillId of this.selectedSkillIds) {
          this.dependencies.evolution.recordSuccess(skillId, this.usage.steps, recoveryRounds, taskType);
        }
        this.dependencies.evolution.recordRun(taskType, true);
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

      if (this.dependencies.skillLedger && this.diagnoses.length > 0 && verification.every((item) => item.passed)) {
        const last = this.diagnoses[this.diagnoses.length - 1]!;
        const strategy = this.decisions[this.decisions.length - 1]?.strategy ?? "fix-implementation";
        const evidenceIds = verification.flatMap((item) => item.evidenceIds);
        this.dependencies.skillLedger.record({
          name: "repair-" + last.category,
          trigger: last.message.slice(0, 240),
          category: last.category,
          strategy,
          procedure: ["inspect trusted failure evidence", "apply the successful repair strategy", "run the failing verification", "confirm full verification passes"],
          verification: verification.map((item) => item.criterionId),
          evidenceIds,
        });
        if (this.dependencies.projectMemory && this.projectContext) {
          const now = new Date().toISOString();
          const id = "repair:" + last.fingerprint;
          const entry: ProjectMemoryEntry = { id, project: this.projectContext.root, kind: "repair", content: "Failure: " + last.category + "\nStrategy: " + strategy + "\nResolution: " + last.message.slice(0, 1200), source: "brain-recovery", confidence: 0.85, createdAt: now, updatedAt: now, uses: 0 };
          await this.wait(() => this.dependencies.projectMemory!.save(entry));
          this.projectMemory = [...this.projectMemory.filter((item) => item.id !== id), entry];
        }
        this.emit({ type: "brain.learning.recorded" });
      }

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

      const remainingRisks = [message];
      if (this.dependencies.evolution && understanding) {
        this.dependencies.evolution.recordRun(understanding.requiredCapabilities[0] ?? "general", false);
      }
      if (input.rollbackOnFailure && checkpointId) {
        try {
          const restored = await this.io(() => this.dependencies.tools.rollback(checkpointId!, this.signal));
          remainingRisks.push("Rolled back " + restored.length + " workspace file(s) to the pre-run checkpoint.");
          this.emit({ type: "brain.checkpoint.rolled_back", count: restored.length });
        } catch (rollbackError) {
          remainingRisks.push("Rollback failed: " + errorMessage(rollbackError));
        }
      }

      return this.report(
        false,
        `Brain execution failed: ${message}`,
        verification,
        [],
        false,
        remainingRisks,
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
