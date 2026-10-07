import type { AgentResult } from "../agent/types.js";
import type { AcceptanceCriterion } from "../brain/types.js";
import type { SofiaExperienceOptions } from "../experience/types.js";

export interface AgentRunInput {
  task: string;
  workspace?: string;
  context?: Record<string, unknown>|string;
  maxSteps?: number;
  stream?: boolean;
  sessionId?: string;
  acceptanceCriteria?: AcceptanceCriterion[];
  experience?: SofiaExperienceOptions;
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
  maxRunsPerKeyPerDay?: number;
  maxToolCallsPerKeyPerDay?: number;
  allowedOrigins?: string[];
}
