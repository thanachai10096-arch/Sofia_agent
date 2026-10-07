export type TaskKind =
  | "coding"
  | "debugging"
  | "research"
  | "analysis"
  | "vision"
  | "general";

export type ModelCapability =
  | "fast"
  | "reasoning"
  | "coding"
  | "vision"
  | "long-context"
  | "tool-use";

export interface ModelRoute {
  id: string;
  /** Internal provider key; never exposed to API consumers. */
  providerId?: string;
  capabilities: ModelCapability[];
  costWeight: number;
  latencyWeight: number;
  qualityWeight: number;
  healthy: boolean;
}

export interface ModelRequest {
  task: string;
  kind: TaskKind;
  context?: string;
  step: number;
}

export interface ModelResponse {
  text: string;
  confidence?: number;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface ModelProvider {
  generate(request: ModelRequest, route: ModelRoute): Promise<ModelResponse>;
}
