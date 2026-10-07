import type { AgentResult } from "../agent/types.js";

export interface AgentRunInput {
  task: string;
  workspace?: string;
  context?: Record<string, unknown>|string;
  maxSteps?: number;
  stream?: boolean;
  sessionId?: string;
  acceptanceCriteria?: Array<{ id: string; description: string; probe: { tool: string; input: Record<string, unknown> } }>;
  priority?: "normal" | "high";
}

export interface AgentRunResponse {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  createdAt?: string;
  updatedAt?: string;
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
  maxRunsPerKeyPerDay?: number;
  maxToolCallsPerKeyPerDay?: number;
}
