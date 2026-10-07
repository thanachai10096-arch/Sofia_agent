import type { AgentResult } from "../agent/types.js";
import type { AcceptanceCriterion } from "../brain/types.js";

export interface AgentRunInput {
  task: string;
  workspace?: string;
  context?: Record<string, unknown> | string;
  maxSteps?: number;
  stream?: boolean;
  sessionId?: string;
  /**
   * Mobile-friendly mode: return immediately and keep the agent running on
   * the server so the client can reconnect and poll for the result.
   */
  async?: boolean;
  acceptanceCriteria?: AcceptanceCriterion[];
  priority?: "normal" | "high";
}

export type AgentRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface AgentRunResponse {
  id: string;
  status: AgentRunStatus;
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
  /**
   * Allowed browser origins. Defaults to "*" for the model-agnostic API.
   * Keep the master API key on a trusted server; do not ship it in a browser.
   */
  allowedOrigins?: string[];
  runRetentionMs?: number;
  requestTimeoutMs?: number;
  maxConcurrentRunsPerKey?: number;
}
