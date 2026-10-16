import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentDependencies } from "../agent/types.js";
import { FileConversationStore } from "../conversation/file-store.js";
import { FileRunRecordStore } from "./run-record-store.js";
import { createSofiaApi } from "./server.js";
import type { SofiaApiConfig } from "./types.js";

export interface SofiaLocalApiOptions {
  /**
   * Persistent directory for Sofia's local API state.
   * Defaults to SOFIA_STATE_DIR, then a per-user temporary-directory location.
   */
  stateDirectory?: string;
}

/**
 * Create a single-process local API with file-backed run and conversation stores.
 *
 * This convenience factory explicitly enables conversation endpoints. The file
 * stores are not a multi-process or serverless database; use transactional
 * shared storage and a durable queue for horizontally scaled deployments.
 */
export function createSofiaLocalApi(
  deps: AgentDependencies,
  config: SofiaApiConfig,
  options: SofiaLocalApiOptions = {},
) {
  const configuredDirectory = options.stateDirectory ?? process.env.SOFIA_STATE_DIR;
  const stateDirectory = path.resolve(
    configuredDirectory?.trim() || path.join(tmpdir(), "sofia-agent"),
  );

  return createSofiaApi(deps, {
    ...config,
    runStore: config.runStore ?? new FileRunRecordStore(path.join(stateDirectory, "api-runs")),
    conversationStore: config.conversationStore ?? new FileConversationStore(path.join(stateDirectory, "conversations")),
  });
}
