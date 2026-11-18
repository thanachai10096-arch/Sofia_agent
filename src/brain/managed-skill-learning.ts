import { actionHash, newSecurityEventId } from "../security/guard.js";
import type { SecurityAuditSink } from "../security/audit.js";
import type { ApprovalHandler } from "../agent/approval.js";
import type { LearnedSkillCandidate } from "./learning.js";
import { runSkillLifecycleWorkflow } from "./skill-lifecycle-workflow.js";
import type { VersionedSkillLifecycle } from "./skill-lifecycle.js";
import type { SkillPackage } from "../skills/platform.js";
import { skillPackageDigest } from "./skill-evidence.js";

/**
 * Connects verified Brain repair candidates to the persisted skill lifecycle.
 * Approval is fail-closed: without a configured approval handler, no skill is activated.
 */
export function createManagedSkillLearningHandler(
  lifecycle: VersionedSkillLifecycle,
  approval?: ApprovalHandler,
  audit?: SecurityAuditSink,
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
    if (!audit) return false;
    const skillDigest = skillPackageDigest(skillPackage);
    const attestationTool = "skill.candidate.attest";
    const attestationInput: Record<string, unknown> = {
      skillId: skillPackage.skill.id,
      skillDigest,
      evidenceIds: [...candidate.evidenceIds],
    };
    try {
      await audit.record({
        id: newSecurityEventId(),
        at: new Date().toISOString(),
        runId,
        ...(principalId ? { principalId } : {}),
        toolName: attestationTool,
        actionHash: actionHash(runId, attestationTool, attestationInput, principalId),
        risk: "low",
        decision: "completed",
        input: attestationInput,
        result: { passed: true, skillDigest },
      });
    } catch {
      return false;
    }
    const result = await runSkillLifecycleWorkflow(
      lifecycle,
      skillPackage,
      {
        source: "verified-brain-repair",
        evidenceIds: [...candidate.evidenceIds],
        confidence: 0.8,
        runId,
        skillDigest,
      },
      {
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
            runId,
            ...(principalId ? { principalId } : {}),
            toolName,
            input,
            actionHash: actionHash(runId, toolName, input, principalId),
            risk: "high",
          });
        },
      },
    );
    return result.activated;
  };
}
