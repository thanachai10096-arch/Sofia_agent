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
  /** Optional untrusted declarative plan; accepted only by the trusted DSL compiler. */
  dsl?: unknown;
}

export interface SkillLedger {
  record(candidate: LearnedSkillCandidate): void;
  list(): readonly LearnedSkillCandidate[];
}

export class InMemorySkillLedger implements SkillLedger {
  private readonly entries = new Map<string, LearnedSkillCandidate>();

  record(candidate: LearnedSkillCandidate): void {
    const key = createHash("sha256")
      .update(JSON.stringify({
        name: candidate.name,
        category: candidate.category,
        procedure: candidate.procedure,
        dsl: candidate.dsl,
      }))
      .digest("hex");
    if (!this.entries.has(key)) {
      // Store a JSON snapshot so later mutation of an untrusted DSL cannot
      // change the candidate after its identity has been calculated.
      const snapshot = JSON.parse(JSON.stringify(candidate)) as LearnedSkillCandidate;
      this.entries.set(key, snapshot);
    }
  }

  list(): readonly LearnedSkillCandidate[] {
    return [...this.entries.values()].map((candidate) =>
      JSON.parse(JSON.stringify(candidate)) as LearnedSkillCandidate,
    );
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
  dsl?: unknown;
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
    ...(input.dsl !== undefined ? { dsl: input.dsl } : {}),
  };
}
