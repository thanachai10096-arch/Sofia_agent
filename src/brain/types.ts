// Modified for Sofia Agents Skill Engine integration on 2026-10-13; provenance notes: docs/engineering/CODE_PROVENANCE_AUDIT.md.
export type BrainState =
  | "idle"
  | "understanding"
  | "planning"
  | "executing"
  | "observing"
  | "verifying"
  | "diagnosing"
  | "replanning"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type FailureCategory =
  | "syntax_error"
  | "type_error"
  | "runtime_error"
  | "dependency_error"
  | "permission_error"
  | "network_error"
  | "tool_error"
  | "wrong_assumption"
  | "incomplete_solution"
  | "environment_error"
  | "unknown";

export type Strategy =
  | "initial"
  | "inspect-evidence"
  | "fix-implementation"
  | "fix-environment"
  | "alternative-tool";

export interface TaskUnderstanding {
  objective: string;
  constraints: string[];
  assumptions: string[];
  requiredCapabilities: string[];
  requiredTools: string[];
  risk: "low" | "medium" | "high";
  successCriteria: string[];
  ambiguities: string[];
}

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

export interface PlanStep {
  id: string;
  objective: string;
  dependencies: string[];
  call: ToolCall;
}

export interface ExecutionPlan {
  strategy: Strategy;
  reason: string;
  steps: PlanStep[];
}

export interface ToolResult {
  ok: boolean;
  data: unknown;
  evidenceId: string;
  error?: { category: FailureCategory; message: string };
}

export interface ToolExecutionContext {
  runId: string;
  principalId?: string | undefined;
  signal: AbortSignal;
  requireApproval: boolean;
  notifyApproval(waiting: boolean): void;
}

export interface WorkspaceCheckpoint {
  id: string;
  revision: string;
}

export interface WorkspaceSnapshot {
  id: string;
  revision: string;
  evidenceId: string;
}

export interface ToolGateway {
  listTools?(): Array<{ name: string; description: string; effects: readonly ("read" | "write" | "shell" | "network" | "browser" | "destructive")[] }>;
  describe(name: string): {
    effects: readonly ("read" | "write" | "shell" | "network" | "browser" | "destructive")[];
  } | undefined;
  execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult>;
  snapshot(signal: AbortSignal): Promise<WorkspaceSnapshot>;
  changedFiles(baselineSnapshotId: string, signal: AbortSignal): Promise<string[]>;
  checkpoint(signal: AbortSignal): Promise<WorkspaceCheckpoint>;
  rollback(checkpointId: string, signal: AbortSignal): Promise<string[]>;
}

export interface PreparedInference {
  inputTokens: number;
  invoke(options: {
    signal: AbortSignal;
    maxOutputTokens: number;
  }): Promise<{ value: unknown; usage: { inputTokens: number; outputTokens: number } }>;
}

export interface BrainReasoner {
  prepare(request: string, options: {
    signal: AbortSignal;
    maxContextTokens: number;
  }): Promise<PreparedInference>;
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  probe: ToolCall;
  evaluate(data: unknown): { passed: boolean; detail: string };
}

export interface VerificationResult {
  criterionId: string;
  passed: boolean;
  detail: string;
  evidenceIds: string[];
  workspaceRevision: string;
  /** Structured fields copied only from the trusted project.verify result. */
  exitCode?: number;
  checksPassed?: boolean;
  assertionsPassed?: boolean;
  assertionsTotal?: number;
  failedAssertions?: number;
  skippedAssertions?: number;
  /** Counts parsed from the trusted Node TAP test-runner summary. */
  testsTotal?: number;
  passedTests?: number;
  failedTests?: number;
  skippedTests?: number;
  cancelledTests?: number;
  todoTests?: number;
}

export interface Diagnosis {
  category: FailureCategory;
  fingerprint: string;
  repeated: number;
  message: string;
  attemptedStrategies: Strategy[];
}

export interface Observation {
  stepId: string;
  tool: string;
  ok: boolean;
  evidenceId: string;
  preview: string;
  truncated: boolean;
  /** Heuristic signal: tool output contains instruction-like text. */
  suspicious?: boolean;
}

export interface BrainLimits {
  maxSteps: number;
  maxToolCalls: number;
  maxReplans: number;
  maxModelCalls: number;
  maxTokens: number;
  maxContextTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface CompletionReport {
  completed: boolean;
  state: BrainState;
  summary: string;
  changedFiles: string[];
  changedFilesKnown: boolean;
  verification: VerificationResult[];
  remainingRisks: string[];
  usage: {
    steps: number;
    toolCalls: number;
    modelCalls: number;
    reservedOrUsedTokens: number;
    replans: number;
  };
}

export interface BrainEvent {
  type: string;
  runId: string;
  state?: BrainState;
  stepId?: string;
  count?: number;
  passed?: boolean;
  category?: FailureCategory;
}
