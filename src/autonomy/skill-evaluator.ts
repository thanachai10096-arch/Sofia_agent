import { createHash } from "node:crypto";
import { evaluateSkillPromotion, type SkillPromotionEvidence } from "./controller.js";
import type { LearnedSkillCandidate } from "../brain/learning.js";

export interface SkillCandidateEvaluationEvidence extends SkillPromotionEvidence {
  /** Digest of the exact candidate that the test suite evaluated. */
  candidateDigest: string;
  /** Immutable artifact version produced by the evaluation pipeline. */
  artifactVersion: string;
}

export interface SkillCandidateEvaluation {
  eligible: boolean;
  candidateDigest: string;
  artifactVersion?: string;
  reasons: string[];
}

/** Stable digest binds evaluation evidence to the exact skill content tested. */
export function digestSkillCandidate(candidate: LearnedSkillCandidate): string {
  const canonical = JSON.stringify({
    name: candidate.name,
    trigger: candidate.trigger,
    category: candidate.category,
    strategy: candidate.strategy,
    procedure: [...candidate.procedure],
    verification: [...candidate.verification],
    evidenceIds: [...candidate.evidenceIds],
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function validateCandidate(candidate: LearnedSkillCandidate): string[] {
  const reasons: string[] = [];
  if (!candidate || typeof candidate !== "object") return ["Skill candidate is missing or malformed."];
  if (typeof candidate.name !== "string" || !candidate.name.trim() || candidate.name.length > 120) reasons.push("Candidate name is invalid.");
  if (typeof candidate.trigger !== "string" || !candidate.trigger.trim() || candidate.trigger.length > 1000) reasons.push("Candidate trigger is invalid.");
  if (typeof candidate.category !== "string" || !candidate.category.trim()) reasons.push("Candidate category is invalid.");
  if (typeof candidate.strategy !== "string" || !candidate.strategy.trim()) reasons.push("Candidate strategy is invalid.");
  if (!Array.isArray(candidate.procedure) || candidate.procedure.length < 1 || candidate.procedure.length > 30 ||
      candidate.procedure.some((step) => typeof step !== "string" || !step.trim() || step.length > 1000)) {
    reasons.push("Candidate procedure must contain 1–30 bounded, non-empty steps.");
  }
  if (!Array.isArray(candidate.verification) || candidate.verification.length < 1 || candidate.verification.length > 20 ||
      candidate.verification.some((step) => typeof step !== "string" || !step.trim() || step.length > 500)) {
    reasons.push("Candidate verification must contain 1–20 bounded checks.");
  }
  if (!Array.isArray(candidate.evidenceIds) || candidate.evidenceIds.length < 1 || candidate.evidenceIds.length > 100 ||
      candidate.evidenceIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 500)) {
    reasons.push("Candidate requires 1–100 valid evidence identifiers.");
  }
  return reasons;
}

/**
 * Evaluates a skill candidate without promoting or executing it.
 * Evidence must be bound to the exact candidate digest to prevent stale or
 * unrelated test results from authorizing a different skill artifact.
 */
export function evaluateSkillCandidate(
  candidate: LearnedSkillCandidate,
  evidence: SkillCandidateEvaluationEvidence,
): SkillCandidateEvaluation {
  const reasons = validateCandidate(candidate);
  if (reasons.length) return { eligible: false, candidateDigest: "", reasons };

  const candidateDigest = digestSkillCandidate(candidate);
  if (!evidence || typeof evidence !== "object") {
    return { eligible: false, candidateDigest, reasons: ["Evaluation evidence is missing."] };
  }
  if (evidence.candidateDigest !== candidateDigest) {
    reasons.push("Evaluation evidence does not match this exact skill candidate.");
  }
  if (typeof evidence.artifactVersion !== "string" || !evidence.artifactVersion.trim() || evidence.artifactVersion.length > 200) {
    reasons.push("A versioned evaluation artifact is required.");
  }

  const promotion = evaluateSkillPromotion(evidence);
  if (!promotion.allowed) reasons.push(promotion.reason);
  return {
    eligible: reasons.length === 0,
    candidateDigest,
    ...(typeof evidence.artifactVersion === "string" && evidence.artifactVersion.trim()
      ? { artifactVersion: evidence.artifactVersion } : {}),
    reasons,
  };
}
