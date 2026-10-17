import type { SkillPackage } from "../skills/platform.js";
import {
  VersionedSkillLifecycle,
  type SkillLifecycleRecord,
  type SkillProvenance,
} from "./skill-lifecycle.js";

export interface SkillLifecycleWorkflowOptions {
  /** Explicit operator/user approval is required before promotion. */
  approvePromotion: (candidate: SkillLifecycleRecord) => Promise<boolean>;
}

export interface SkillLifecycleWorkflowResult {
  candidate: SkillLifecycleRecord;
  activated: boolean;
  reason: "evaluation_rejected" | "approval_declined" | "promoted";
}

/**
 * The production workflow for introducing a skill: persist provenance, evaluate,
 * then require explicit approval before changing the active SkillsPlatform.
 * Skill instructions are metadata only; this workflow never executes them.
 */
export async function runSkillLifecycleWorkflow(
  lifecycle: VersionedSkillLifecycle,
  skillPackage: SkillPackage,
  provenance: SkillProvenance,
  options: SkillLifecycleWorkflowOptions,
): Promise<SkillLifecycleWorkflowResult> {
  const proposed = lifecycle.propose(skillPackage, provenance);
  const evaluated = await lifecycle.evaluate(proposed.id);
  if (evaluated.status !== "verified" || evaluated.evaluation?.passed !== true) {
    return { candidate: evaluated, activated: false, reason: "evaluation_rejected" };
  }

  if (!(await options.approvePromotion(evaluated))) {
    return { candidate: evaluated, activated: false, reason: "approval_declined" };
  }

  const promoted = lifecycle.promote(evaluated.id);
  return { candidate: promoted, activated: true, reason: "promoted" };
}
