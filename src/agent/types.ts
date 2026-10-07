import type { ModelProvider, ModelRoute, TaskKind, ToolCall } from "../models/types.js";

export interface AgentRequest {
  task: string;
  context?: string;
  sessionId?: string;
  maxSteps?: number;
}

export interface AgentEvent {
  type:
    | "run.started"
    | "task.classified"
    | "model.selected"
    | "model.completed"
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
}

export interface AgentDependencies {
  provider: ModelProvider;
  router: { select(kind: TaskKind): ModelRoute; markUnhealthy(id: string): void };
  reviewer: { review(task: string, output: string): Promise<{ approved: boolean; reason: string }> };
}

export type { ToolCall };
