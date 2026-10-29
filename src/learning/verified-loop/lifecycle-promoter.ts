import { actionHash } from "../../security/guard.js";
import type { ApprovalHandler } from "../../agent/approval.js";
import type { SkillPackage } from "../../skills/platform.js";
import { runSkillLifecycleWorkflow } from "../../brain/skill-lifecycle-workflow.js";
import type { VersionedSkillLifecycle } from "../../brain/skill-lifecycle.js";
import type { LearningScope, SkillCandidate } from "./ports.js";

export interface LearningLifecyclePromotionOptions {
  lifecycle: VersionedSkillLifecycle;
  approval?: ApprovalHandler;
  /** Resolve only evidence IDs that the authoritative verifier has persisted for this experience. */
  resolveEvidenceIds: (scope: LearningScope, experienceId: string) => Promise<string[]>;
  /** Bind the approval request to the originating Sofia run. */
  resolveRunId: (scope: LearningScope, candidate: SkillCandidate) => string;
}

/**
 * Adapter for the existing VersionedSkillLifecycle. A verified-learning candidate
 * remains inactive unless the lifecycle evaluator passes and the configured
 * approval handler explicitly approves the exact promotion action.
 */
export function createLearningLifecyclePromoter(
  options: LearningLifecyclePromotionOptions,
): (scope: LearningScope, candidate: SkillCandidate) => Promise<boolean> {
  return async (scope, candidate) => {
    if (!options.approval) return false;
    // The promoter is a public adapter boundary: do not rely solely on the
    // learning loop having validated a candidate before it reaches this call.
    if (!scope || !candidate || !candidate.scope ||
        candidate.scope.tenantId !== scope.tenantId ||
        candidate.scope.principalId !== scope.principalId ||
        candidate.scope.projectId !== scope.projectId) return false;
    if (![scope.tenantId, scope.principalId, scope.projectId].every(value => typeof value === "string" && value.trim().length > 0)) return false;
    if (typeof candidate.id !== "string" || !candidate.id.trim() || candidate.id.length > 200 ||
        typeof candidate.name !== "string" || !candidate.name.trim() || candidate.name.length > 120 ||
        typeof candidate.trigger !== "string" || !candidate.trigger.trim() || candidate.trigger.length > 500 ||
        typeof candidate.experienceId !== "string" || !candidate.experienceId.trim() || candidate.experienceId.length > 200 ||
        !Array.isArray(candidate.procedure) || candidate.procedure.length < 1 || candidate.procedure.length > 30 ||
        !candidate.procedure.every(step => typeof step === "string" && step.trim().length > 0 && step.length <= 1000) ||
        !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) return false;
    const evidenceIds = await options.resolveEvidenceIds(scope, candidate.experienceId);
    if (!Array.isArray(evidenceIds) || evidenceIds.length === 0 ||
        !evidenceIds.every(id => typeof id === "string" && id.trim().length > 0 && id.length <= 500)) return false;

    const skillPackage: SkillPackage = {
      skill: {
        id: candidate.id,
        name: candidate.name,
        description: "Learned from repeated completions with trusted verification evidence.",
        triggers: [candidate.trigger],
        categories: ["unknown"],
        strategy: "inspect-evidence",
        procedure: [...candidate.procedure],
        verification: ["typecheck", "test", "build"],
      },
      source: "learned",
      version: "1.0.0",
      publisher: "sofia-verified-learning",
    };
    const runId = options.resolveRunId(scope, candidate);
    if (typeof runId !== "string" || !runId.trim()) return false;

    const result = await runSkillLifecycleWorkflow(
      options.lifecycle,
      skillPackage,
      { source: "verified-learning-loop", evidenceIds: [...evidenceIds], confidence: candidate.confidence },
      {
        approvePromotion: async record => {
          const toolName = "skill.lifecycle.promote";
          const input: Record<string, unknown> = {
            candidateId: record.id,
            skillId: record.skillId,
            skillName: record.package.skill.name,
            experienceId: candidate.experienceId,
            evidenceIds: [...record.provenance.evidenceIds],
            confidence: record.provenance.confidence,
          };
          return options.approval!({
            runId,
            principalId: scope.principalId,
            toolName,
            input,
            actionHash: actionHash(runId, toolName, input, scope.principalId),
            risk: "high",
          });
        },
      },
    );
    return result.activated;
  };
}
