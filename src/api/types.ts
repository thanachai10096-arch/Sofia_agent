import type { AgentResult } from "../agent/types.js";
import type { RunRecordStore } from "./run-record-store.js";
import type { WorkflowOrchestratorDependencies } from "../brain/workflow-orchestrator.js";

export interface AgentRunInput {
  task: string;
  workspace?: string;
  context?: string;
  maxSteps?: number;
  stream?: boolean;
  sessionId?: string;
  /**
   * Mobile-friendly mode: return immediately and keep the agent running on
   * the server so the client can reconnect and poll for the result.
   */
  async?: boolean;
  acceptanceCriteria?: Array<{
    id: string;
    description: string;
    probe: { tool: string; input: Record<string, unknown> };
  }>;
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
  /**
   * Optional trusted mapping from API key to a stable end-user identity.
   * Configure only from a server-side authenticated identity provider. Never
   * populate this map from request headers, query parameters, or request JSON.
   * Keys omitted from this map remain isolated by their hashed API-key identity.
   */
  principalIdsByApiKey?: Record<string, string>;
  maxBodyBytes?: number;
  maxRunsPerKeyPerDay?: number;
  maxToolCallsPerKeyPerDay?: number;
  /**
   * Allowed browser origins. If omitted or empty, cross-origin browser access is not granted.
   * Keep the master API key on a trusted server; do not ship it in a browser.
   */
  allowedOrigins?: string[];
  runRetentionMs?: number;
  requestTimeoutMs?: number;
  maxConcurrentRunsPerKey?: number;
  securityAdminScope?: string;
  /** Optional durable run store; queued/running runs become failed after restart. */
  runStore?: RunRecordStore;
  /** Configure real ToolGateway execution, checkpointing, reconciliation, and principal-bound approval. If absent, workflow endpoints fail closed. */
  workflowRuntime?: (principalId: string) => Omit<WorkflowOrchestratorDependencies, "store">;
  /** Optional persistent root for per-principal workflow plans. */
  workflowStateRoot?: string;
}
