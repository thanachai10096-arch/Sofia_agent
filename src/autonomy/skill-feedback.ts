import { createHash } from "node:crypto";
import type { LearnedSkillCandidate } from "../brain/learning.js";
import { digestSkillCandidate } from "./skill-evaluator.js";

export type SkillExecutionOutcome = "succeeded" | "failed" | "aborted";

export interface SkillExecutionFeedback {
  id: string;
  scope: string;
  skillName: string;
  skillVersion: string;
  candidateDigest: string;
  outcome: SkillExecutionOutcome;
  /** Host-generated evidence references; never accept model-authored proof. */
  evidenceIds: string[];
  /** Count emitted by trusted safety monitor, not the model. */
  safetyIncidentCount: number;
  recordedBy: string;
  recordedAt: string;
  idempotencyKey: string;
}

export interface SkillFeedbackInput {
  scope: string;
  actor: string;
  skillName: string;
  skillVersion: string;
  candidateDigest: string;
  outcome: SkillExecutionOutcome;
  evidenceIds: string[];
  safetyIncidentCount: number;
  idempotencyKey: string;
}

export interface SkillFeedbackState {
  entries: SkillExecutionFeedback[];
  idempotency: Record<string, string>;
}

export interface SkillFeedbackStore {
  transact<T>(scope: string, operation: (state: SkillFeedbackState) => T | Promise<T>): Promise<T>;
}

export interface SkillFeedbackSummary {
  skillName: string;
  skillVersion: string;
  candidateDigest: string;
  total: number;
  succeeded: number;
  failed: number;
  aborted: number;
  successRate: number;
  safetyIncidents: number;
  evidenceIds: string[];
  recommendation: "insufficient-data" | "retain" | "review" | "disable-pending-review";
}

function validInput(input: SkillFeedbackInput): boolean {
  return Boolean(input && input.scope?.trim() && input.scope.length <= 512 &&
    input.actor?.trim() && input.actor.length <= 256 &&
    input.skillName?.trim() && input.skillName.length <= 120 &&
    input.skillVersion?.trim() && input.skillVersion.length <= 200 &&
    /^[a-f0-9]{64}$/i.test(input.candidateDigest) &&
    ["succeeded", "failed", "aborted"].includes(input.outcome) &&
    Array.isArray(input.evidenceIds) && input.evidenceIds.length > 0 &&
    input.evidenceIds.length <= 100 &&
    input.evidenceIds.every((id) => typeof id === "string" && id.trim() && id.length <= 500) &&
    Number.isSafeInteger(input.safetyIncidentCount) && input.safetyIncidentCount >= 0 &&
    input.idempotencyKey?.trim() && input.idempotencyKey.length <= 200);
}

/**
 * Records host-verified execution outcomes for an exact immutable skill version.
 * Feedback informs review; it never edits, promotes, disables, or rolls back a skill.
 */
export class SkillFeedbackLedger {
  constructor(private readonly store: SkillFeedbackStore) {}

  async record(input: SkillFeedbackInput): Promise<{ recorded: boolean; feedback: SkillExecutionFeedback }> {
    if (!validInput(input)) throw new Error("Skill feedback is malformed or missing trusted evidence.");
    return this.store.transact(input.scope, (state) => {
      const existingId = state.idempotency[input.idempotencyKey];
      if (existingId) {
        const existing = state.entries.find((entry) => entry.id === existingId);
        if (!existing) throw new Error("Skill feedback idempotency index is inconsistent.");
        return { recorded: false, feedback: existing };
      }
      const id = createHash("sha256")
        .update([input.scope, input.idempotencyKey, input.skillName, input.skillVersion].join("\n"))
        .digest("hex");
      const feedback: SkillExecutionFeedback = {
        id, scope: input.scope, skillName: input.skillName, skillVersion: input.skillVersion,
        candidateDigest: input.candidateDigest, outcome: input.outcome,
        evidenceIds: [...new Set(input.evidenceIds)], safetyIncidentCount: input.safetyIncidentCount,
        recordedBy: input.actor, recordedAt: new Date().toISOString(),
        idempotencyKey: input.idempotencyKey,
      };
      state.entries.push(feedback);
      state.idempotency[input.idempotencyKey] = id;
      return { recorded: true, feedback };
    });
  }

  async summarize(scope: string, skillName: string, skillVersion: string): Promise<SkillFeedbackSummary | null> {
    if (!scope?.trim() || scope.length > 512 || !skillName?.trim() || !skillVersion?.trim()) return null;
    return this.store.transact(scope, (state) => {
      const entries = state.entries.filter((entry) =>
        entry.skillName === skillName && entry.skillVersion === skillVersion);
      if (entries.length === 0) return null;
      const succeeded = entries.filter((entry) => entry.outcome === "succeeded").length;
      const failed = entries.filter((entry) => entry.outcome === "failed").length;
      const aborted = entries.filter((entry) => entry.outcome === "aborted").length;
      const safetyIncidents = entries.reduce((sum, entry) => sum + entry.safetyIncidentCount, 0);
      const total = entries.length;
      const successRate = succeeded / total;
      const recommendation = safetyIncidents > 0
        ? "disable-pending-review"
        : total < 5
          ? "insufficient-data"
          : failed / total >= 0.3 || successRate < 0.7
            ? "review"
            : "retain";
      return {
        skillName, skillVersion, candidateDigest: entries[0]!.candidateDigest,
        total, succeeded, failed, aborted, successRate, safetyIncidents,
        evidenceIds: [...new Set(entries.flatMap((entry) => entry.evidenceIds))].slice(0, 500),
        recommendation,
      };
    });
  }
}

/** Reference implementation for tests; production must use a transactional durable adapter. */
export class InMemorySkillFeedbackStore implements SkillFeedbackStore {
  private readonly states = new Map<string, SkillFeedbackState>();
  private readonly queues = new Map<string, Promise<void>>();

  async transact<T>(scope: string, operation: (state: SkillFeedbackState) => T | Promise<T>): Promise<T> {
    const previous = this.queues.get(scope) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => lock);
    this.queues.set(scope, queued);
    await previous;
    try {
      const state = structuredClone(this.states.get(scope) ?? { entries: [], idempotency: {} });
      const result = await operation(state);
      this.states.set(scope, state);
      return result;
    } finally {
      release();
      if (this.queues.get(scope) === queued) this.queues.delete(scope);
    }
  }
}


export interface SkillImprovementProposal {
  currentCandidateDigest: string;
  proposedCandidate: LearnedSkillCandidate;
  feedbackEvidenceIds: string[];
  rationale: string;
}

/**
 * Asks a host-supplied reasoning adapter to draft a revision from measured
 * feedback. The result is only a candidate: caller must run the normal
 * evaluator and explicit promotion flow. This function cannot mutate registry.
 */
export async function proposeSkillImprovement(
  current: LearnedSkillCandidate,
  summary: SkillFeedbackSummary,
  propose: (input: {
    current: LearnedSkillCandidate;
    feedback: SkillFeedbackSummary;
  }) => Promise<{ candidate: LearnedSkillCandidate; rationale: string }>,
): Promise<SkillImprovementProposal | null> {
  if (!current || !summary || summary.skillName !== current.name ||
      summary.recommendation === "retain" || summary.recommendation === "insufficient-data" ||
      summary.evidenceIds.length === 0 || digestSkillCandidate(current) !== summary.candidateDigest) {
    return null;
  }
  const result = await propose({ current: structuredClone(current), feedback: structuredClone(summary) });
  if (!result || !result.candidate || result.candidate.name !== current.name ||
      !Array.isArray(result.candidate.procedure) || result.candidate.procedure.length === 0 ||
      !Array.isArray(result.candidate.verification) || result.candidate.verification.length === 0 ||
      !Array.isArray(result.candidate.evidenceIds) ||
      !summary.evidenceIds.every((id) => result.candidate.evidenceIds.includes(id)) ||
      digestSkillCandidate(result.candidate) === summary.candidateDigest ||
      typeof result.rationale !== "string" || !result.rationale.trim() || result.rationale.length > 2000) {
    throw new Error("Skill improvement adapter returned an invalid or ungrounded candidate.");
  }
  return {
    currentCandidateDigest: summary.candidateDigest,
    proposedCandidate: structuredClone(result.candidate),
    feedbackEvidenceIds: [...summary.evidenceIds],
    rationale: result.rationale,
  };
}
