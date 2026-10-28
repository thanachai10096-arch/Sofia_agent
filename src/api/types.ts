import type { AgentResult } from "../agent/types.js";
import type { RunRecordStore } from "./run-record-store.js";
import type { DiscordInteractionTransport } from "../integrations/messaging/discord-interaction-transport.js";

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
  /** Select an available model profile for this run, or let Sofia route automatically. */
  modelSelection?: "auto" | "fast" | "coding" | "reasoning" | "vision";
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
  /** Optional durable quota store. Share its filesystem path across API processes only when the filesystem supports atomic exclusive file creation and rename. */
  usageStorePath?: string;
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
  /** Optional Discord interactions route; signature verification is delegated to the supplied transport. */
  discordInteractionRoute?: {
    transport: DiscordInteractionTransport;
    path?: string;
    maxBodyBytes?: number;
  };
}
