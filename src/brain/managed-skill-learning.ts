import { actionHash } from "../security/guard.js";
import type { ApprovalHandler } from "../agent/approval.js";
import type { LearnedSkillCandidate } from "./learning.js";
import { runSkillLifecycleWorkflow } from "./skill-lifecycle-workflow.js";
import type { VersionedSkillLifecycle } from "./skill-lifecycle.js";
import type { SkillPackage } from "../skills/platform.js";

/**
 * Connects verified Brain repair candidates to the persisted skill lifecycle.
 * Promotion is fail-closed unless both a trusted approval handler and an
 * authenticated principal are present.
 */
export function createManagedSkillLearningHandler(
  lifecycle: VersionedSkillLifecycle,
  approval?: ApprovalHandler,
): (candidate: LearnedSkillCandidate, runId: string, principalId?: string) => Promise<boolean> {
  return async (candidate, runId, principalId) => {
    const authenticatedPrincipalId = principalId?.trim();
    // Never allow an approval adapter to turn an anonymous promotion into an
    // authorized one. The identity is part of the approval request and hash.
    if (!approval || !authenticatedPrincipalId) return false;

    const skillPackage: SkillPackage = {
      skill: {
        id: `learned:${candidate.name}:${candidate.category}`,
        name: candidate.name,
        description: "Learned from a workflow that passed trusted verification.",
        triggers: [candidate.trigger],
        categories: [candidate.category],
        strategy: candidate.strategy,
        procedure: [...candidate.procedure],
        verification: ["typecheck", "test", "build"],
      },
      source: "learned",
      version: "1.0.0",
      publisher: "sofia",
    };
    const result = await runSkillLifecycleWorkflow(
      lifecycle,
      skillPackage,
      {
        source: candidate.name.startsWith("repair-") ? "verified-brain-repair" : "verified-brain-workflow",
        evidenceIds: [...candidate.evidenceIds],
        confidence: 0.8,
      },
      {
        approvePromotion: async (record) => {
          const toolName = "skill.lifecycle.promote";
          const input: Record<string, unknown> = {
            candidateId: record.id,
            skillId: record.skillId,
            skillName: record.package.skill.name,
            category: candidate.category,
            evidenceIds: [...record.provenance.evidenceIds],
            confidence: record.provenance.confidence,
          };
          return approval({
            runId,
            principalId: authenticatedPrincipalId,
            toolName,
            input,
            actionHash: actionHash(runId, toolName, input, authenticatedPrincipalId),
            risk: "high",
          });
        },
      },
    );
    return result.activated;
  };
}
