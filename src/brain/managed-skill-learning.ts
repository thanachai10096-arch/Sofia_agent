import { randomUUID } from "node:crypto";
import { actionHash } from "../security/guard.js";
import type { ApprovalHandler } from "../agent/approval.js";
import type { LearnedSkillCandidate } from "./learning.js";
import { SkillSelfImprovementLoop } from "./skill-self-improvement.js";
import type { VersionedSkillLifecycle } from "./skill-lifecycle.js";
import type { SkillExecutableArtifact, SkillPackage } from "../skills/platform.js";

/**
 * Connects verified Brain repair outcomes to the bounded self-improvement loop.
 * Approval is fail-closed: without a configured approval handler, no skill is activated.
 */
function skillIdPart(value: string, fallback: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 56);
  return normalized || fallback;
}

export function createManagedSkillLearningHandler(
  lifecycle: VersionedSkillLifecycle,
  approval?: ApprovalHandler,
  buildArtifact?: (candidate: LearnedSkillCandidate) => Promise<SkillExecutableArtifact | undefined>,
): (candidate: LearnedSkillCandidate, runId: string, principalId?: string) => Promise<boolean> {
  return async (candidate, runId, principalId) => {
    // Executable artifacts must come from a trusted compiler/adapter, never from
    // model-authored prose. Without one, keep the candidate as guidance only.
    const artifact = await buildArtifact?.(candidate);
    if (!artifact) return false;
    // Preserve every requested verification requirement. The current isolated
    // runner proves syntax + trusted tests only; dropping typecheck/build here
    // would silently weaken the candidate's declared acceptance criteria.
    const verification = candidate.verification.filter(
      (item): item is "typecheck" | "test" | "build" =>
        item === "typecheck" || item === "test" || item === "build",
    );
    // Do not silently discard unknown requirements from the learned candidate.
    if (verification.length !== candidate.verification.length || !verification.includes("test")) return false;
    const skillPackage: SkillPackage = {
      artifact,
      skill: {
        id: `learned:${skillIdPart(candidate.name, "skill")}:${skillIdPart(candidate.category, "general")}`,
        name: candidate.name,
        description: "Executable skill artifact compiled from a repair with trusted verification evidence.",
        triggers: [candidate.trigger],
        categories: [candidate.category],
        strategy: candidate.strategy,
        procedure: [...candidate.procedure],
        verification,
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
