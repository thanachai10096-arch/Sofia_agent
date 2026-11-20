import { createHash } from "node:crypto";
import type { LearnedSkillCandidate } from "../brain/learning.js";

/** Evidence produced by the trusted evaluator before a skill can be promoted. */
export interface SkillCandidateEvaluationEvidence {
  candidateDigest: string;
  artifactVersion: string;
  testsPassed: boolean;
  adversarialTestsPassed: boolean;
  benchmarkScore: number;
  safetyIncidents: number;
  versionedArtifact: boolean;
  rollbackAvailable: boolean;
}

/**
 * Stable digest of the complete skill candidate. Explicit field selection and
 * sorted evidence IDs make the digest deterministic across object instances.
 */
export function digestSkillCandidate(candidate: LearnedSkillCandidate): string {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("A skill candidate is required.");
  }
  const normalized = {
    name: candidate.name,
    trigger: candidate.trigger,
    category: candidate.category,
    strategy: candidate.strategy,
    procedure: [...candidate.procedure],
    verification: [...candidate.verification],
    evidenceIds: [...candidate.evidenceIds].sort(),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/** Reject incomplete or unsafe evidence; this does not promote a skill. */
export function isSkillCandidateEvaluationEvidence(
  evidence: SkillCandidateEvaluationEvidence,
  expectedDigest: string,
): boolean {
  return Boolean(
    evidence &&
    evidence.candidateDigest === expectedDigest &&
    typeof evidence.artifactVersion === "string" && evidence.artifactVersion.trim() &&
    evidence.testsPassed === true &&
    evidence.adversarialTestsPassed === true &&
    Number.isFinite(evidence.benchmarkScore) &&
    evidence.benchmarkScore >= 0 && evidence.benchmarkScore <= 1 &&
    Number.isSafeInteger(evidence.safetyIncidents) && evidence.safetyIncidents === 0 &&
    evidence.versionedArtifact === true &&
    evidence.rollbackAvailable === true
  );
}
