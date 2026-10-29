import { createHash } from "node:crypto";

import type { FailureCategory, Strategy } from "./types.js";
import { containsPromptInjection, redactSecrets } from "../security/guard.js";

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

function copySkillCandidate(candidate: LearnedSkillCandidate): LearnedSkillCandidate {
  return {
    ...candidate,
    procedure: [...candidate.procedure],
    verification: [...candidate.verification],
    evidenceIds: [...candidate.evidenceIds],
  };
}

const LEARNABLE_CATEGORIES = new Set<FailureCategory>([
  "syntax_error", "type_error", "runtime_error", "dependency_error",
  "permission_error", "network_error", "tool_error", "wrong_assumption",
  "incomplete_solution", "environment_error", "unknown",
]);
const LEARNABLE_STRATEGIES = new Set<Strategy>([
  "initial", "inspect-evidence", "fix-implementation", "fix-environment", "alternative-tool",
]);

export class InMemorySkillLedger implements SkillLedger {
  private readonly entries = new Map<string, LearnedSkillCandidate>();

  record(candidate: LearnedSkillCandidate): void {
    if (!candidate || typeof candidate !== "object" ||
        typeof candidate.name !== "string" || candidate.name.trim().length === 0 || candidate.name.length > 200 ||
        typeof candidate.trigger !== "string" || candidate.trigger.trim().length === 0 || candidate.trigger.length > 240 ||
        !LEARNABLE_CATEGORIES.has(candidate.category) || !LEARNABLE_STRATEGIES.has(candidate.strategy) ||
        !Array.isArray(candidate.procedure) || candidate.procedure.length < 2 || candidate.procedure.length > 100 ||
        !candidate.procedure.every(step => typeof step === "string" && step.trim().length > 0 && step.length <= 2000) ||
        !Array.isArray(candidate.verification) || candidate.verification.length < 1 || candidate.verification.length > 3 ||
        !candidate.verification.every(item => item === "typecheck" || item === "test" || item === "build") ||
        !Array.isArray(candidate.evidenceIds) || candidate.evidenceIds.length < 1 || candidate.evidenceIds.length > 100 ||
        !candidate.evidenceIds.every(id => typeof id === "string" && id.trim().length > 0 && id.length <= 500) ||
        new Set(candidate.evidenceIds).size !== candidate.evidenceIds.length) {
      throw new Error("Invalid learned skill candidate");
    }

    const safe = copySkillCandidate({
      ...candidate,
      name: String(redactSecrets(candidate.name)).slice(0, 200),
      trigger: String(redactSecrets(candidate.trigger)).slice(0, 240),
      procedure: candidate.procedure.map(step => String(redactSecrets(step)).slice(0, 2000)),
      evidenceIds: candidate.evidenceIds.map(id => String(redactSecrets(id)).slice(0, 500)),
    });
    if (containsPromptInjection(safe.name) || containsPromptInjection(safe.trigger) ||
        safe.procedure.some(step => containsPromptInjection(step))) {
      throw new Error("Learned skill candidate rejected by prompt-injection guard");
    }
    if (new Set(safe.evidenceIds).size !== safe.evidenceIds.length) {
      throw new Error("Learned skill candidate evidence IDs collide after secret redaction");
    }

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
    return [...this.entries.values()].map(copySkillCandidate);
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
