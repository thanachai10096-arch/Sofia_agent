import { digestSkillCandidate, evaluateSkillCandidate } from "./skill-evaluator.js";
import type { LearnedSkillCandidate } from "../brain/learning.js";
import type { SkillRegistryIdentity, SkillRegistryStore, SkillRegistryVersion } from "./skill-registry.js";

export interface ResolvedSkill {
  name: string;
  version: string;
  candidateDigest: string;
  trigger: string;
  procedure: readonly string[];
  verification: readonly string[];
  evidenceIds: readonly string[];
}

/**
 * Runtime resolution exposes only the active, re-validated skill instructions.
 * It never evaluates code, invokes tools, grants capabilities or changes policy.
 * The caller must still route every proposed action through Brain/ToolGateway.
 */
export class SkillRuntime {
  constructor(private readonly registry: SkillRegistryStore) {}

  async resolve(identity: SkillRegistryIdentity, skillName: string): Promise<ResolvedSkill | null> {
    if (!identity || typeof identity.actor !== "string" || !identity.actor.trim() ||
        typeof identity.scope !== "string" || !identity.scope.trim() ||
        identity.actor.length > 256 || identity.scope.length > 512 ||
        typeof skillName !== "string" || !skillName.trim() || skillName.length > 120) return null;

    return this.registry.transact(identity.scope, (state) => {
      const activeVersion = state.active[skillName];
      if (!activeVersion) return null;
      const versions = state.versions[skillName];
      if (!Array.isArray(versions)) return null;
      const record = versions.find((entry: SkillRegistryVersion) => entry.version === activeVersion);
      if (!record || !record.candidate || typeof record.candidate !== "object" ||
          !record.evidence || typeof record.evidence !== "object" ||
          record.candidate.name !== skillName || record.version !== record.evidence.artifactVersion) return null;
      const evaluation = evaluateSkillCandidate(record.candidate, record.evidence);
      if (!evaluation.eligible || evaluation.candidateDigest !== record.candidateDigest ||
          evaluation.artifactVersion !== record.version ||
          digestSkillCandidate(record.candidate) !== record.candidateDigest) return null;

      const candidate: LearnedSkillCandidate = record.candidate;
      return {
        name: candidate.name,
        version: record.version,
        candidateDigest: record.candidateDigest,
        trigger: candidate.trigger,
        procedure: [...candidate.procedure],
        verification: [...candidate.verification],
        evidenceIds: [...candidate.evidenceIds],
      };
    });
  }
}
