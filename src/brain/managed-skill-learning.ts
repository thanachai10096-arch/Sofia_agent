import { randomUUID } from "node:crypto";
import { actionHash } from "../security/guard.js";
import type { ApprovalHandler } from "../agent/approval.js";
import type { LearnedSkillCandidate } from "./learning.js";
import { SkillSelfImprovementLoop } from "./skill-self-improvement.js";
import type { VersionedSkillLifecycle } from "./skill-lifecycle.js";
import type { SkillPackage } from "../skills/platform.js";

/**
 * Connects verified Brain repair outcomes to the bounded self-improvement loop.
 * Approval is fail-closed: without a configured approval handler, no skill is activated.
 */
export function createManagedSkillLearningHandler(
  lifecycle: VersionedSkillLifecycle,
  approval?: ApprovalHandler,
): (candidate: LearnedSkillCandidate, runId: string, principalId?: string) => Promise<boolean> {
  return async (candidate, runId, principalId) => {
    const skillPackage: SkillPackage = {
      skill: {
        id: `learned:${candidate.name}:${candidate.category}`,
        name: candidate.name,
        description: "Learned from a repair that passed trusted verification.",
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
    const loop = new SkillSelfImprovementLoop(lifecycle, {
      propose: async () => [{
        skillPackage,
        provenance: {
          source: "verified-brain-repair",
          evidenceIds: [...candidate.evidenceIds],
          confidence: 0.8,
        },
      }],
    }, {
      maxEvidence: 64,
      maxProposalsPerRun: 1,
      approvePromotion: async (record) => {
        if (!approval) return false;
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
          requestId: randomUUID(),
          runId,
          ...(principalId ? { principalId } : {}),
          toolName,
          input,
          actionHash: actionHash(runId, toolName, input, principalId),
          risk: "high",
        });
      },
    });
    const report = await loop.run(candidate.evidenceIds.map((id) => ({
      id,
      skillId: skillPackage.skill.id,
      category: candidate.category,
      summary: `Verified repair evidence for ${candidate.name}: ${candidate.trigger}`,
      verified: true,
    })));
    return report.promoted === 1;
  };
}
