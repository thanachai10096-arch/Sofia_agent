import type { AgentResult } from "../agent/types.js";
import type { RunRecordStore } from "./run-record-store.js";
import type { UsageStore } from "./usage.js";
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
  /** Legacy plaintext-token map. Prefer apiKeyHashes for deployments that can store only hashes. */
  apiKeys: Record<string, string[]>;
  /** SHA-256 hex digest of each bearer token mapped to its scopes; allows hash-only API key configuration. */
  apiKeyHashes?: Record<string, string[]>;
  /** Optional secret used as an HMAC key for hash-only API key authentication. */
  apiKeyHashSecret?: string;
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
  /** Optional persistent API usage quota store; local file stores are single-process only. */
  usageStore?: UsageStore;
  /** Optional readiness probe for orchestrators; false keeps /ready at HTTP 503. */
  readinessCheck?: () => boolean | Promise<boolean>;
  /** Optional Discord interactions route; signature verification is delegated to the supplied transport. */
  discordInteractionRoute?: {
    transport: DiscordInteractionTransport;
    path?: string;
    maxBodyBytes?: number;
  };
}
