import type { FailureCategory, Strategy } from "./types.js";
import type { LearnedSkillCandidate, SkillLedger } from "./learning.js";

export interface SofiaSkill {
  id: string;
  name: string;
  description: string;
  triggers: readonly string[];
  categories: readonly FailureCategory[];
  strategy: Strategy;
  procedure: readonly string[];
  verification: readonly ("typecheck" | "test" | "build")[];
}

const BUILTIN_SKILLS: readonly SofiaSkill[] = [
  {
    id: "typescript-error-repair",
    name: "TypeScript error repair",
    description: "Diagnose and repair common TypeScript compiler failures.",
    triggers: ["TS", "typescript", "type '", "does not exist", "not assignable"],
    categories: ["type_error", "syntax_error"],
    strategy: "fix-implementation",
    procedure: ["inspect compiler output", "locate referenced symbols/files", "make the smallest implementation fix", "run typecheck"],
    verification: ["typecheck"],
  },
  {
    id: "dependency-repair",
    name: "Dependency repair",
    description: "Repair missing or incompatible project dependencies.",
    triggers: ["module not found", "cannot find module", "npm", "dependency"],
    categories: ["dependency_error"],
    strategy: "fix-environment",
    procedure: ["inspect package manifest and lockfile", "confirm the missing dependency", "make the smallest dependency/environment change", "run typecheck"],
    verification: ["typecheck"],
  },
  {
    id: "test-failure-repair",
    name: "Test failure repair",
    description: "Use failing tests as evidence and repair the implementation.",
    triggers: ["test failed", "assertion", "expected", "received"],
    categories: ["runtime_error", "incomplete_solution"],
    strategy: "fix-implementation",
    procedure: ["inspect the failing test", "trace the failing behavior", "make the smallest fix", "run the failing test or test suite"],
    verification: ["test"],
  },
  {
    id: "ci-failure-triage",
    name: "CI failure triage",
    description: "Diagnose continuous-integration failures from authoritative logs and fix root causes without weakening tests or security.",
    triggers: ["CI failed", "workflow run", "ENOTEMPTY", "cross-platform", "failing job"],
    categories: ["runtime_error", "environment_error"],
    strategy: "inspect-evidence",
    procedure: [
      "Inspect the exact failed job, commit SHA, and first actionable error in the authoritative CI logs.",
      "Separate a product defect from a test-fixture, runner, dependency, or transient environment failure.",
      "Make the smallest root-cause fix; never skip, weaken, or delete a test merely to obtain a green build.",
      "Run the focused test and relevant typecheck/build locally when possible, then rerun CI on the new commit.",
      "Report the exact commit and verified platform results, and leave unverified checks explicitly pending.",
    ],
    verification: ["test", "build"],
  },
];

function learnedToSkill(skill: LearnedSkillCandidate): SofiaSkill {
  return {
    id: `learned:${skill.name}:${skill.category}`,
    name: skill.name,
    description: "Learned from a previously verified repair.",
    triggers: [skill.trigger],
    categories: [skill.category],
    strategy: skill.strategy,
    procedure: skill.procedure,
    verification: skill.verification.filter(
      (item): item is "typecheck" | "test" | "build" =>
        item === "typecheck" || item === "test" || item === "build",
    ),
  };
}

export function matchSkills(
  category: FailureCategory,
  message: string,
  limit = 3,
  ledger?: SkillLedger,
): SofiaSkill[] {
  const lower = message.toLowerCase();
  const all = [
    ...BUILTIN_SKILLS,
    ...(ledger?.list() ?? []).map(learnedToSkill),
  ];
  return all
    .map((skill) => ({
      skill,
      score:
        (skill.categories.includes(category) ? 100 : 0) +
        skill.triggers.filter((trigger) => lower.includes(trigger.toLowerCase())).length * 10,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
    .slice(0, limit)
    .map((item) => item.skill);
}

export function compactSkillContext(skills: readonly SofiaSkill[]): unknown[] {
  return skills.map((skill) => ({
    id: skill.id,
    strategy: skill.strategy,
    procedure: skill.procedure,
    verification: skill.verification,
  }));
}

export function allBuiltinSkills(): SofiaSkill[] {
  return [...BUILTIN_SKILLS];
}
