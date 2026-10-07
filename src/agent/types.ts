import type { ModelProvider, ModelRoute, TaskKind, ToolCall } from "../models/types.js";
import type { WorkspaceRuntime } from "../platform/runtime.js";
import type { ExecutionPolicy } from "../security/policy.js";
import type { ToolRegistry } from "../tools/types.js";
import type { AcceptanceCriterion, CompletionReport } from "../brain/types.js";
import type { SofiaBrain } from "../brain/executor.js";
import type { SofiaExperienceOptions, SofiaProgress } from "../experience/types.js";

export interface AgentRequest {
  task: string;
  context?: string;
  sessionId?: string;
  maxSteps?: number;
  acceptanceCriteria?: AcceptanceCriterion[];
  useBrain?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  experience?: SofiaExperienceOptions;
  onProgress?: (progress: SofiaProgress) => void;
}

export interface AgentEvent {
  type:
    | "run.started"
    | "task.classified"
    | "model.selected"
    | "model.completed"
    | "tool.started"
    | "tool.completed"
    | "tool.failed"
    | "tool.approval_required"
    | "review.started"
    | "review.completed"
    | "retry"
    | "run.completed"
    | "run.failed";
  message: string;
  step?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentResult {
  runId: string;
  output: string;
  kind: TaskKind;
  steps: number;
  events: AgentEvent[];
  progress?: import("../experience/types.js").SofiaProgress[];
  brainReport?: CompletionReport;
}

export interface AgentDependencies {
  provider: ModelProvider;
  router: {
    select(kind: TaskKind): ModelRoute;
    markUnhealthy(id: string): void;
  };
  reviewer: {
    review(task: string, output: string): Promise<{ approved: boolean; reason: string }>;
  };
  /**
   * These dependencies are optional because Sofia Brain can execute without
   * the legacy runtime/tool loop. The legacy path validates them at runtime.
   */
  runtime?: WorkspaceRuntime;
  tools?: ToolRegistry;
  policy?: ExecutionPolicy;
  approval?: import("./approval.js").ApprovalHandler;
  brainFactory?: (options: { signal?: AbortSignal; maxSteps?: number }) => SofiaBrain;
}

export type { ToolCall };
