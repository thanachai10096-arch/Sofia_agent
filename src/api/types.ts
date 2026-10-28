import type { AgentResult } from "../agent/types.js";
import type { RunRecordStore } from "./run-record-store.js";
import type { DiscordInteractionTransport } from "../integrations/messaging/discord-interaction-transport.js";
import type { SlackEventsTransport } from "../integrations/messaging/slack-events-transport.js";
import type { LineWebhookTransport } from "../integrations/messaging/line-webhook-transport.js";
import type { WhatsAppWebhookTransport } from "../integrations/messaging/whatsapp-webhook-transport.js";
import type { CronSchedule, CronExecution } from "../brain/cron-scheduler.js";
import type { JobRecord } from "../brain/job-runtime.js";

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
  /** Deliver a terminal cron result to its trusted origin. Return true only when the provider accepted it. */
  onCronExecutionFinished?: (schedule: CronSchedule, execution: CronExecution, job?: JobRecord) => Promise<boolean> | boolean;
  /** Optional Discord interactions route; signature verification is delegated to the supplied transport. */
  discordInteractionRoute?: {
    transport: DiscordInteractionTransport;
    path?: string;
    maxBodyBytes?: number;
  };
  /** Optional Slack Events API route; preserves raw body for Slack signature verification. */
  slackEventsRoute?: {
    transport: SlackEventsTransport;
    path?: string;
    maxBodyBytes?: number;
  };
  /** Optional LINE Messaging API webhook route; verifies X-Line-Signature on raw bytes. */
  lineWebhookRoute?: {
    transport: LineWebhookTransport;
    path?: string;
    maxBodyBytes?: number;
  };
  /** Optional Meta WhatsApp Cloud API route; supports GET challenge and signed POST events. */
  whatsAppWebhookRoute?: {
    transport: WhatsAppWebhookTransport;
    path?: string;
    maxBodyBytes?: number;
  };
}
