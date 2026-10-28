import { actionHash } from "../security/guard.js";
import type { ApprovalHandler } from "../agent/approval.js";
import type { LearnedSkillCandidate } from "./learning.js";
import { runSkillLifecycleWorkflow } from "./skill-lifecycle-workflow.js";
import type { VersionedSkillLifecycle } from "./skill-lifecycle.js";
import type { SkillPackage } from "../skills/platform.js";
import type { SkillVerification } from "./skills.js";

export interface ManagedSkillLearningOptions {
  /**
   * Opt-in approval gate for skill promotion. Defaults to false so verified,
   * metadata-only skills can be promoted automatically, like Hermes.
   * Set SOFIA_SKILL_WRITE_APPROVAL=true to require the host approval handler.
   */
  requireApproval?: boolean;
}

/**
 * Connects verified Brain repair candidates to the persisted skill lifecycle.
 * A trusted authenticated principal is always required. By default, promotion
 * is automatic only after the lifecycle evaluator passes; skill instructions
 * remain metadata and are not executed by this handler. Hosts can opt into an
 * explicit, action-hash-bound approval gate for promotion.
 */
export function createManagedSkillLearningHandler(
  lifecycle: VersionedSkillLifecycle,
  approval?: ApprovalHandler,
  options: ManagedSkillLearningOptions = {},
): (candidate: LearnedSkillCandidate, runId: string, principalId?: string) => Promise<boolean> {
  return async (candidate, runId, principalId) => {
    const authenticatedPrincipalId = principalId?.trim();
    // Never promote skills for anonymous work, even when approval is disabled.
    if (!authenticatedPrincipalId) return false;
    // Promotion must be tied to real successful verification evidence; never
    // fabricate typecheck/test/build claims for arbitrary acceptance criteria.
    if (candidate.evidenceIds.length === 0 || candidate.procedure.length < 2 || candidate.verification.length === 0) return false;

    const requireApproval = options.requireApproval ?? process.env.SOFIA_SKILL_WRITE_APPROVAL === "true";
    if (requireApproval && !approval) return false;

    const skillPackage: SkillPackage = {
      skill: {
        id: `learned:${candidate.name}:${candidate.category}`,
        name: candidate.name,
        description: "Learned from a workflow that passed trusted verification.",
        triggers: [...new Set([candidate.trigger, ...(candidate.triggers ?? [])])]
          .map((trigger) => String(trigger).trim().slice(0, 500))
          .filter(Boolean)
          .slice(0, 12),
        categories: [candidate.category],
        strategy: candidate.strategy,
        procedure: [...candidate.procedure].slice(0, 12),
        verification: [...new Set(candidate.verification.map((item): SkillVerification => {
          if (item === "typecheck" || item === "test" || item === "build") return item;
          const rawId = String(item).startsWith("acceptance:")
            ? String(item).slice("acceptance:".length)
            : String(item);
          const safeId = rawId.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 160);
          return `acceptance:${safeId || "verified-check"}`;
        }))],
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
          if (!requireApproval) return true;
          // The guard above ensures approval is present when required.
          const toolName = "skill.lifecycle.promote";
          const input: Record<string, unknown> = {
            candidateId: record.id,
            skillId: record.skillId,
            skillName: record.package.skill.name,
            category: candidate.category,
            evidenceIds: [...record.provenance.evidenceIds],
            confidence: record.provenance.confidence,
          };
          return approval!({
            runId,
            principalId: authenticatedPrincipalId,
            toolName,
            input,
            actionHash: actionHash(runId, toolName, input, authenticatedPrincipalId),
            risk: "medium",
          });
        },
      },
    );
    return result.activated;
  };
}
