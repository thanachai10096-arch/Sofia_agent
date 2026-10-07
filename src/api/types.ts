import type { AgentResult } from "../agent/types.js";

export interface AgentRunInput {
  task: string;
  workspace?: string;
  context?: Record<string, unknown>;
  maxSteps?: number;
}

export interface AgentRunResponse {
  id: string;
  status: "completed" | "failed";
  result?: AgentResult;
  error?: string;
}

export interface ApiAuth {
  keyId: string;
  scopes: string[];
}

export interface SofiaApiConfig {
  apiKeys: Record<string, string[]>;
  maxBodyBytes?: number;
}
