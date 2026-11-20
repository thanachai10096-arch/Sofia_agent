import type { SkillExecutionResultEvent } from "../brain/executor.js";
import { SkillFeedbackLedger } from "./skill-feedback.js";
import { SkillRuntime } from "./skill-runtime.js";
import type { SkillRegistryStore } from "./skill-registry.js";

export interface BrainSkillFeedbackRecorderOptions {
  registry: SkillRegistryStore;
  ledger: SkillFeedbackLedger;
  /** Resolve a trusted tenant/project scope from the authenticated principal. */
  resolveScope(principalId: string): string | Promise<string>;
  /** Return the incident count from the trusted host safety monitor for this tool event. */
  resolveSafetyIncidentCount(event: SkillExecutionResultEvent): number | Promise<number>;
}

/**
 * Connects Brain's active learned-skill execution events to the immutable
 * registry and feedback ledger. Built-in/unregistered skills are ignored.
 */
export function createBrainSkillFeedbackRecorder(
  options: BrainSkillFeedbackRecorderOptions,
): (event: SkillExecutionResultEvent) => Promise<void> {
  const runtime = new SkillRuntime(options.registry);
  return async (event): Promise<void> => {
    const principalId = event.principalId?.trim();
    if (!principalId || !event.runId?.trim() || !event.stepId?.trim() ||
        !event.evidenceId?.trim() || !event.skillId.startsWith("learned:")) return;

    const separator = event.skillId.lastIndexOf(":");
    if (separator <= "learned:".length) return;
    const skillName = event.skillId.slice("learned:".length, separator).trim();
    if (!skillName) return;

    const scope = (await options.resolveScope(principalId)).trim();
    if (!scope || scope.length > 512) return;
    const skill = await runtime.resolve({ actor: principalId, scope }, skillName);
    if (!skill) return;

    const safetyIncidentCount = await options.resolveSafetyIncidentCount(event);
    if (!Number.isSafeInteger(safetyIncidentCount) || safetyIncidentCount < 0) {
      throw new Error("Trusted safety monitor returned an invalid incident count.");
    }

    await options.ledger.record({
      scope,
      actor: principalId,
      skillName: skill.name,
      skillVersion: skill.version,
      candidateDigest: skill.candidateDigest,
      outcome: event.outcome,
      evidenceIds: [event.evidenceId],
      safetyIncidentCount,
      idempotencyKey: `${event.runId}:${event.stepId}`,
    });
  };
}
