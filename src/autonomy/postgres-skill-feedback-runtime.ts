import type { SkillExecutionResultEvent } from "../brain/executor.js";
import type { AutonomyPgPool } from "./postgres-job-store.js";
import { PostgresSkillFeedbackStore } from "./postgres-skill-feedback-store.js";
import { PostgresSkillRegistryStore } from "./postgres-skill-registry-store.js";
import { SkillFeedbackLedger } from "./skill-feedback.js";

/** Host-owned inputs for durable, tenant-scoped learned-skill feedback. */
export interface PostgresSkillFeedbackRuntimeOptions {
  /** A trusted server-side pool. Never construct this from request or model input. */
  pool: AutonomyPgPool;
  /** Set false after an operator-managed migration; runtime DB role then needs no DDL grants. */
  initializeSchema?: boolean;
  /** Resolve tenant/project scope from the authenticated principal. */
  resolveScope(principalId: string): string | Promise<string>;
  /** Read incident counts from the trusted host safety monitor. */
  resolveSafetyIncidentCount(event: SkillExecutionResultEvent): number | Promise<number>;
}

/**
 * Initialize durable registry + feedback stores and return the only supported
 * host configuration for wiring learned-skill execution feedback into Brain.
 * Schema creation is explicit and must run under a migration-capable DB role.
 */
export async function createPostgresSkillFeedbackHostConfig(
  options: PostgresSkillFeedbackRuntimeOptions,
): Promise<{
  registry: PostgresSkillRegistryStore;
  ledger: SkillFeedbackLedger;
  resolveScope: PostgresSkillFeedbackRuntimeOptions["resolveScope"];
  resolveSafetyIncidentCount: PostgresSkillFeedbackRuntimeOptions["resolveSafetyIncidentCount"];
}> {
  if (!options || !options.pool || typeof options.pool.query !== "function" ||
      typeof options.pool.connect !== "function" ||
      typeof options.resolveScope !== "function" ||
      typeof options.resolveSafetyIncidentCount !== "function") {
    throw new Error("Trusted PostgreSQL pool and host identity/safety resolvers are required.");
  }
  const registry = new PostgresSkillRegistryStore(options.pool);
  const feedbackStore = new PostgresSkillFeedbackStore(options.pool);
  // Schema creation is opt-out for least-privilege runtime roles; migrations can run separately.
  if (options.initializeSchema !== false) {
    // Do not expose a partially initialized configuration if either schema fails.
    await registry.ensureSchema();
    await feedbackStore.ensureSchema();
  }
  return {
    registry,
    ledger: new SkillFeedbackLedger(feedbackStore),
    resolveScope: options.resolveScope,
    resolveSafetyIncidentCount: options.resolveSafetyIncidentCount,
  };
}
