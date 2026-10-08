import { createHash } from "node:crypto";
import type { FailureCategory, Strategy } from "./types.js";

export type SkillLifecycle = "candidate" | "probation" | "trusted" | "stale" | "deprecated";

export interface LearnedSkillCandidate {
  name: string;
  trigger: string;
  category: FailureCategory;
  strategy: Strategy;
  procedure: string[];
  verification: string[];
  evidenceIds: string[];
  confidence?: number;
  attempts?: number;
  successes?: number;
  failures?: number;
  lastUsedAt?: string;
  lastSucceededAt?: string;
  createdAt?: string;
  updatedAt?: string;
  source?: "agent" | "human" | "builtin";
  lifecycle?: SkillLifecycle;
  lastFailedAt?: string;
  deprecatedAt?: string;
}

export interface SkillOutcome {
  skillName: string;
  success: boolean;
  evidenceIds?: string[];
  category?: FailureCategory;
  strategy?: Strategy;
  message?: string;
}

export interface FailureMemory {
  id: string;
  fingerprint: string;
  category: FailureCategory;
  message: string;
  strategy?: Strategy;
  skillName?: string;
  attempts: number;
  resolved: boolean;
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SkillScore {
  skill: LearnedSkillCandidate;
  score: number;
  reasons: string[];
}

export interface SkillLedger {
  record(candidate: LearnedSkillCandidate): void | Promise<void>;
  list(): readonly LearnedSkillCandidate[] | Promise<readonly LearnedSkillCandidate[]>;
  recordOutcome?(outcome: SkillOutcome): void | Promise<void>;
  recordFailure?(failure: FailureMemory): void | Promise<void>;
  listFailures?(query?: string): readonly FailureMemory[] | Promise<readonly FailureMemory[]>;
  rank?(category: FailureCategory, message: string, limit?: number): readonly SkillScore[] | Promise<readonly SkillScore[]>;
}

export class InMemorySkillLedger implements SkillLedger {
  private readonly entries = new Map<string, LearnedSkillCandidate>();
  private readonly failures = new Map<string, FailureMemory>();

  record(candidate: LearnedSkillCandidate): void {
    const key = skillKey(candidate);
    const previous = this.entries.get(key);
    this.entries.set(key, mergeSkill(previous, candidate));
  }

  list(): readonly LearnedSkillCandidate[] {
    return [...this.entries.values()];
  }

  recordOutcome(outcome: SkillOutcome): void {
    const current = [...this.entries.values()].find((skill) => skill.name === outcome.skillName);
    if (!current) return;
    this.entries.set(skillKey(current), updateOutcome(current, outcome));
  }

  recordFailure(failure: FailureMemory): void {
    const previous = this.failures.get(failure.fingerprint);
    this.failures.set(failure.fingerprint, {
      ...failure,
      attempts: Math.max(previous?.attempts ?? 0, failure.attempts),
      resolved: previous?.resolved || failure.resolved,
    });
  }

  listFailures(query?: string): readonly FailureMemory[] {
    const items = [...this.failures.values()];
    if (!query) return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20);
    return rankFailures(items, query).slice(0, 20);
  }

  rank(category: FailureCategory, message: string, limit = 5): readonly SkillScore[] {
    return rankLearnedSkills([...this.entries.values()], category, message, limit);
  }
}

function skillKey(candidate: Pick<LearnedSkillCandidate, "name" | "category" | "strategy" | "trigger">): string {
  return createHash("sha256")
    .update(JSON.stringify({
      name: candidate.name,
      category: candidate.category,
      strategy: candidate.strategy,
      trigger: candidate.trigger.toLowerCase().slice(0, 600),
    }))
    .digest("hex");
}

function mergeSkill(previous: LearnedSkillCandidate | undefined, candidate: LearnedSkillCandidate): LearnedSkillCandidate {
  const now = new Date().toISOString();
  const attempts = Math.max(previous?.attempts ?? 0, candidate.attempts ?? 0);
  const successes = Math.max(previous?.successes ?? 0, candidate.successes ?? 0);
  const failures = Math.max(previous?.failures ?? 0, candidate.failures ?? 0);
  const merged: LearnedSkillCandidate = {
    ...previous,
    ...candidate,
    confidence: clamp(candidate.confidence ?? previous?.confidence ?? 0.55),
    attempts,
    successes,
    failures,
    createdAt: previous?.createdAt ?? candidate.createdAt ?? now,
    updatedAt: now,
    source: candidate.source ?? previous?.source ?? "agent",
    lifecycle: candidate.lifecycle ?? previous?.lifecycle,
  };
  return { ...merged, lifecycle: nextSkillLifecycle(merged) };
}

function updateOutcome(skill: LearnedSkillCandidate, outcome: SkillOutcome): LearnedSkillCandidate {
  const attempts = (skill.attempts ?? 0) + 1;
  const successes = (skill.successes ?? 0) + (outcome.success ? 1 : 0);
  const failures = (skill.failures ?? 0) + (outcome.success ? 0 : 1);
  const empirical = successes / attempts;
  const prior = clamp(skill.confidence ?? 0.55);
  const confidence = clamp((prior * 2 + empirical * attempts) / (attempts + 2));
  const now = new Date().toISOString();
  const next: LearnedSkillCandidate = {
    ...skill,
    confidence,
    attempts,
    successes,
    failures,
    lastUsedAt: now,
    ...(outcome.success ? { lastSucceededAt: now } : { lastFailedAt: now }),
    evidenceIds: [...new Set([...(skill.evidenceIds ?? []), ...(outcome.evidenceIds ?? [])])].slice(-40),
    updatedAt: now,
  };
  return { ...next, lifecycle: nextSkillLifecycle(next) };
}

export function rankLearnedSkills(
  skills: readonly LearnedSkillCandidate[],
  category: FailureCategory,
  message: string,
  limit = 5,
): SkillScore[] {
  const lower = message.toLowerCase();
  const terms = tokenize(lower);
  return skills
    .map((skill) => {
      const triggerHits = tokenize(skill.trigger).filter((term) => terms.includes(term)).length;
      const categoryBoost = skill.category === category ? 45 : 0;
      const strategyBoost = skill.strategy === "fix-implementation" && category === "incomplete_solution" ? 8 : 0;
      const confidence = clamp(skill.confidence ?? 0.55) * 35;
      const attempts = skill.attempts ?? 0;
      const empirical = attempts > 0 ? (skill.successes ?? 0) / attempts : 0.5;
      const reliability = empirical * 25;
      const lifecycleBoost = skill.lifecycle === "trusted" ? 8 : skill.lifecycle === "probation" ? 2 : skill.lifecycle === "stale" ? -12 : skill.lifecycle === "deprecated" ? -100 : 0;
      const failurePenalty = Math.min(skill.failures ?? 0, 8) * 2;
      const evidenceBoost = Math.min((skill.evidenceIds?.length ?? 0), 10);
      const lifecycleBoost = skill.lifecycle === "trusted" ? 8 : skill.lifecycle === "probation" ? 2 : skill.lifecycle === "stale" ? -12 : skill.lifecycle === "deprecated" ? -100 : 0;
      const failurePenalty = Math.min(skill.failures ?? 0, 8) * 2;
      const score = categoryBoost + triggerHits * 8 + confidence + strategyBoost + reliability + evidenceBoost + lifecycleBoost - failurePenalty;
      const reasons = [
        ...(categoryBoost ? ["same failure category"] : []),
        ...(triggerHits ? [`${triggerHits} matching trigger terms`] : []),
        `confidence ${Math.round((skill.confidence ?? 0.55) * 100)}%`,
        ...(attempts ? [`${skill.successes ?? 0}/${attempts} successful uses`] : []),
      ];
      return { skill, score, reasons };
    })
    .filter((item) => item.skill.lifecycle !== "deprecated" && item.score > 20)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, limit);
}

function rankFailures(items: FailureMemory[], query: string): FailureMemory[] {
  const terms = tokenize(query.toLowerCase());
  return items
    .map((failure) => ({
      failure,
      score: (failure.resolved ? 5 : 0) + tokenize(failure.message).filter((t) => terms.includes(t)).length * 4,
    }))
    .sort((a, b) => b.score - a.score || b.failure.updatedAt.localeCompare(a.failure.updatedAt))
    .map((item) => item.failure);
}

function tokenize(value: string): string[] {
  return [...new Set(value.split(/[^a-z0-9_:-]+/i).filter((term) => term.length >= 3))];
}

function nextSkillLifecycle(skill: Pick<LearnedSkillCandidate, "attempts" | "successes" | "failures" | "lastUsedAt" | "lifecycle">): SkillLifecycle {
  const attempts = skill.attempts ?? 0;
  const successes = skill.successes ?? 0;
  const failures = skill.failures ?? 0;
  const rate = attempts > 0 ? successes / attempts : 0;
  if (skill.lifecycle === "deprecated") return "deprecated";
  if (attempts >= 5 && rate < 0.35 && failures >= 3) return "deprecated";
  if (skill.lastUsedAt && Date.now() - Date.parse(skill.lastUsedAt) > 1000 * 60 * 60 * 24 * 30) return "stale";
  if (attempts >= 3 && rate >= 0.8) return "trusted";
  if (attempts >= 1) return "probation";
  return "candidate";
}

export function lifecycleForSkill(skill: LearnedSkillCandidate): SkillLifecycle {
  return nextSkillLifecycle(skill);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5));
}

export function shouldLearn(completed: boolean, verificationPassed: boolean, evidenceIds: readonly string[]): boolean {
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
    source: "agent",
  };
}
