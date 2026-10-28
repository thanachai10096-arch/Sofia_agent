import type { SkillPackage } from "../skills/platform.js";
import type { SkillEvaluationResult } from "./skill-lifecycle.js";

/**
 * Conservative production evaluator for learned skill candidates.
 *
 * The current runtime does not yet execute candidate procedures against isolated,
 * repeatable task fixtures. Consequently metadata validation is diagnostic only and
 * MUST NOT be reported as successful task verification. A future fixture runner can
 * replace this adapter while preserving the lifecycle's explicit approval and rollback.
 */
export async function evaluateLearnedSkillCandidate(candidate: SkillPackage): Promise<SkillEvaluationResult> {
  const checks = [
    {
      name: "skill-metadata",
      passed: Boolean(candidate.skill.id && candidate.skill.name.trim() && candidate.skill.description.trim()),
    },
    {
      name: "procedure",
      passed: candidate.skill.procedure.length >= 2 && candidate.skill.procedure.every((step) => step.trim().length > 0),
    },
    {
      name: "verification",
      passed: candidate.skill.verification.length > 0 &&
        candidate.skill.verification.every((item) => ["typecheck", "test", "build"].includes(item)),
    },
    {
      name: "isolated-task-fixture-evaluation",
      passed: false,
      detail: "No isolated skill task-fixture evaluator is configured; metadata checks alone cannot verify task outcomes.",
    },
  ];
  return { passed: false, checks };
}
