import { createHash } from "node:crypto";

import type { FailureCategory, Strategy } from "./types.js";

export interface LearnedSkillCandidate {
  name: string;
  trigger: string;
  /** Additional observed trigger phrases merged from repeated verified runs. */
  triggers?: string[];
  category: FailureCategory;
  strategy: Strategy;
  procedure: string[];
  verification: string[];
  evidenceIds: string[];
}

export interface SkillLedger {
  record(candidate: LearnedSkillCandidate): void;
  list(): readonly LearnedSkillCandidate[];
}

export class InMemorySkillLedger implements SkillLedger {
  private readonly entries = new Map<string, LearnedSkillCandidate>();

  record(candidate: LearnedSkillCandidate): void {
    const key = createHash("sha256")
      .update(JSON.stringify({ name: candidate.name, category: candidate.category }))
      .digest("hex");
    const previous = this.entries.get(key);
    const merged: LearnedSkillCandidate = previous ? {
      ...candidate,
      trigger: previous.trigger,
      triggers: [...new Set([previous.trigger, ...(previous.triggers ?? []), candidate.trigger, ...(candidate.triggers ?? [])])].slice(0, 12),
      procedure: [...new Set([...previous.procedure, ...candidate.procedure])].slice(0, 12),
      verification: [...new Set([...previous.verification, ...candidate.verification])],
      evidenceIds: [...new Set([...previous.evidenceIds, ...candidate.evidenceIds])].slice(-50),
    } : {
      ...candidate,
      triggers: [...new Set([candidate.trigger, ...(candidate.triggers ?? [])])].slice(0, 12),
      evidenceIds: [...new Set(candidate.evidenceIds)].slice(-50),
    };
    this.entries.set(key, merged);
  }

  list(): readonly LearnedSkillCandidate[] {
    return [...this.entries.values()];
  }
}

export function shouldLearn(
  completed: boolean,
  verificationPassed: boolean,
  evidenceIds: readonly string[],
): boolean {
  return completed && verificationPassed && evidenceIds.length > 0;
}

export function buildSkillCandidate(input: {
  category: FailureCategory;
  strategy: Strategy;
  message: string;
  evidenceIds: string[];
}): LearnedSkillCandidate {
  return {
    name: `repair-${input.category}`,
    trigger: input.message.slice(0, 240),
    category: input.category,
    strategy: input.strategy,
    procedure: [
      "inspect trusted failure evidence",
      "apply the selected repair strategy",
      "run the trusted verification that failed",
      "confirm the full task verification passes",
    ],
    verification: ["typecheck", "test", "build"],
    evidenceIds: [...input.evidenceIds],
  };
}
