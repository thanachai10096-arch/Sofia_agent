import { createHash } from "node:crypto";

import type { FailureCategory, Strategy } from "./types.js";

export interface LearnedSkillCandidate {
  name: string;
  trigger: string;
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

function copyLearnedSkillCandidate(candidate: LearnedSkillCandidate): LearnedSkillCandidate {
  return {
    ...candidate,
    procedure: [...candidate.procedure],
    verification: [...candidate.verification],
    evidenceIds: [...candidate.evidenceIds],
  };
}

export class InMemorySkillLedger implements SkillLedger {
  private readonly entries = new Map<string, LearnedSkillCandidate>();

  record(candidate: LearnedSkillCandidate): void {
    const safe = copyLearnedSkillCandidate(candidate);
    const key = createHash("sha256")
      .update(JSON.stringify({
        name: safe.name,
        category: safe.category,
        procedure: safe.procedure,
      }))
      .digest("hex");
    if (!this.entries.has(key)) this.entries.set(key, safe);
  }

  list(): readonly LearnedSkillCandidate[] {
    return [...this.entries.values()].map(copyLearnedSkillCandidate);
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
