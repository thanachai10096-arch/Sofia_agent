import { createHash } from "node:crypto";
import type { LearnedSkillCandidate } from "../brain/learning.js";
import {
  evaluateSkillCandidate,
  type SkillCandidateEvaluation,
  type SkillCandidateEvaluationEvidence,
} from "./skill-evaluator.js";

export interface SkillRegistryVersion {
  version: string;
  candidateDigest: string;
  candidate: LearnedSkillCandidate;
  evidence: SkillCandidateEvaluationEvidence;
  promotedBy: string;
  promotedAt: string;
}

export interface SkillRegistryAuditEvent {
  id: string;
  action: "promoted" | "rolled-back";
  skillName: string;
  version: string;
  previousVersion: string | null;
  actor: string;
  at: string;
}

export interface SkillRegistryState {
  versions: Record<string, SkillRegistryVersion[]>;
  active: Record<string, string>;
  audit: SkillRegistryAuditEvent[];
}

/**
 * Implementations MUST provide an atomic, serializable transaction per scope.
 * A database adapter should use a transaction + row/advisory lock. The service
 * deliberately does not ship a process-local production fallback.
 */
export interface SkillRegistryStore {
  transact<T>(scope: string, operation: (state: SkillRegistryState) => Promise<T> | T): Promise<T>;
}

export interface SkillRegistryIdentity {
  /** Host-authenticated user or service principal; never accept from candidate data. */
  actor: string;
  /** Host-resolved project/tenant scope. */
  scope: string;
}

export interface PromoteSkillInput {
  identity: SkillRegistryIdentity;
  candidate: LearnedSkillCandidate;
  evidence: SkillCandidateEvaluationEvidence;
  /** Optimistic concurrency guard; null means the skill must not exist yet. */
  expectedActiveVersion: string | null;
}

export type SkillRegistryResult =
  | { ok: true; version: SkillRegistryVersion; evaluation: SkillCandidateEvaluation }
  | { ok: false; reason: string; evaluation?: SkillCandidateEvaluation };

function emptyState(): SkillRegistryState {
  return { versions: {}, active: {}, audit: [] };
}

function validIdentity(identity: SkillRegistryIdentity): boolean {
  return Boolean(identity && typeof identity.actor === "string" && identity.actor.trim() &&
    typeof identity.scope === "string" && identity.scope.trim() &&
    identity.actor.length <= 256 && identity.scope.length <= 512);
}

function cloneCandidate(candidate: LearnedSkillCandidate): LearnedSkillCandidate {
  return {
    ...candidate,
    procedure: [...candidate.procedure],
    verification: [...candidate.verification],
    evidenceIds: [...candidate.evidenceIds],
  };
}

function eventId(scope: string, action: string, skill: string, version: string, at: string): string {
  return createHash("sha256").update([scope, action, skill, version, at].join("\\n")).digest("hex");
}

/**
 * Evidence-gated, tenant-scoped skill registry lifecycle.
 * Promotion and rollback are registry changes only; they never execute code,
 * grant capabilities, or authorize production deployment.
 */
export class ControlledSkillRegistry {
  constructor(private readonly store: SkillRegistryStore) {}

  async promote(input: PromoteSkillInput): Promise<SkillRegistryResult> {
    if (!input || !validIdentity(input.identity)) return { ok: false, reason: "Authenticated registry identity is required." };
    const evaluation = evaluateSkillCandidate(input.candidate, input.evidence);
    if (!evaluation.eligible || !evaluation.artifactVersion) {
      return { ok: false, reason: "Skill candidate did not pass evidence evaluation.", evaluation };
    }

    return this.store.transact(input.identity.scope, (state) => {
      const skill = input.candidate.name;
      const current = state.active[skill] ?? null;
      if (current !== input.expectedActiveVersion) {
        return { ok: false, reason: "Active skill version changed; refresh before promotion.", evaluation } as const;
      }
      const versions = state.versions[skill] ?? [];
      if (versions.some((entry) => entry.version === evaluation.artifactVersion)) {
        return { ok: false, reason: "Artifact version already exists; versions are immutable.", evaluation } as const;
      }
      const now = new Date().toISOString();
      const version: SkillRegistryVersion = {
        version: evaluation.artifactVersion,
        candidateDigest: evaluation.candidateDigest,
        candidate: cloneCandidate(input.candidate),
        evidence: { ...input.evidence },
        promotedBy: input.identity.actor,
        promotedAt: now,
      };
      state.versions[skill] = [...versions, version];
      state.active[skill] = version.version;
      state.audit.push({
        id: eventId(input.identity.scope, "promoted", skill, version.version, now),
        action: "promoted",
        skillName: skill,
        version: version.version,
        previousVersion: current,
        actor: input.identity.actor,
        at: now,
      });
      return { ok: true, version, evaluation } as const;
    });
  }

  async rollback(identity: SkillRegistryIdentity, skillName: string, targetVersion: string): Promise<SkillRegistryResult> {
    if (!validIdentity(identity) || !skillName?.trim() || !targetVersion?.trim()) {
      return { ok: false, reason: "Authenticated identity, skill name and target version are required." };
    }
    return this.store.transact(identity.scope, (state) => {
      const versions = state.versions[skillName] ?? [];
      const target = versions.find((entry) => entry.version === targetVersion);
      const current = state.active[skillName] ?? null;
      if (!target) return { ok: false, reason: "Rollback target is not present in this registry scope." } as const;
      if (current === targetVersion) return { ok: false, reason: "Target version is already active." } as const;
      const now = new Date().toISOString();
      state.active[skillName] = targetVersion;
      state.audit.push({
        id: eventId(identity.scope, "rolled-back", skillName, targetVersion, now),
        action: "rolled-back",
        skillName,
        version: targetVersion,
        previousVersion: current,
        actor: identity.actor,
        at: now,
      });
      const evaluation: SkillCandidateEvaluation = {
        eligible: true,
        candidateDigest: target.candidateDigest,
        artifactVersion: target.version,
        reasons: [],
      };
      return { ok: true, version: target, evaluation } as const;
    });
  }

  async getActive(identity: SkillRegistryIdentity, skillName: string): Promise<SkillRegistryVersion | null> {
    if (!validIdentity(identity) || !skillName?.trim()) return null;
    return this.store.transact(identity.scope, (state) => {
      const activeVersion = state.active[skillName];
      return (state.versions[skillName] ?? []).find((entry) => entry.version === activeVersion) ?? null;
    });
  }

  async listAudit(identity: SkillRegistryIdentity): Promise<SkillRegistryAuditEvent[]> {
    if (!validIdentity(identity)) return [];
    return this.store.transact(identity.scope, (state) => state.audit.map((event) => ({ ...event })));
  }
}

/** Reference store for tests and single-process development only. */
export class InMemorySkillRegistryStore implements SkillRegistryStore {
  private readonly states = new Map<string, SkillRegistryState>();
  private readonly locks = new Map<string, Promise<void>>();

  async transact<T>(scope: string, operation: (state: SkillRegistryState) => Promise<T> | T): Promise<T> {
    const previous = this.locks.get(scope) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(scope, previous.then(() => lock));
    await previous;
    try {
      const current = this.states.get(scope) ?? emptyState();
      const draft = structuredClone(current);
      const result = await operation(draft);
      this.states.set(scope, draft);
      return result;
    } finally {
      release();
      if (this.locks.get(scope) === lock) this.locks.delete(scope);
    }
  }
}
