// Modified for Sofia Agents Skill Engine integration on 2026-10-13; provenance notes: docs/engineering/CODE_PROVENANCE_AUDIT.md.
import type { FailureCategory, Strategy } from "./types.js";
import type { LearnedSkillCandidate, SkillLedger } from "./learning.js";
import { BUILTIN_SKILLS as POLICY_SKILLS, CAPABILITIES as POLICY_CAPABILITIES, selectSkills as selectPolicySkills } from "./skill-policy-v1.js";
import type { Skill as PolicySkill, TaskType as PolicyTaskType } from "./skill-policy-v1.js";

export interface SofiaSkill {
  id: string;
  name: string;
  description: string;
  triggers: readonly string[];
  categories: readonly FailureCategory[];
  strategy: Strategy;
  procedure: readonly string[];
  verification: readonly ("typecheck" | "test" | "build")[];
  preconditions?: readonly string[];
  failureConditions?: readonly string[];
  recovery?: readonly string[];
  risk?: "read-only" | "may-write";
  riskLevel?: PolicySkill["risk"];
  requiredCapabilities?: PolicySkill["requiredCapabilities"];
  requiredPermissions?: PolicySkill["requiredPermissions"];
  resourceLimits?: PolicySkill["resourceLimits"];
  retryLimit?: number;
  compatibility?: PolicySkill["compatibility"];
  trustLevel?: PolicySkill["trustLevel"];
  provenance?: PolicySkill["provenance"];
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

function policyTaskType(category: FailureCategory, message = ""): PolicyTaskType {
  const normalized = message.toLowerCase();
  if (/\b(test|tests|testing|assertion|suite)\b/.test(normalized)) return "testing";
  if (/\b(api|integration|endpoint|contract)\b/.test(normalized)) return "api";
  if (/\b(browser|website|web research|documentation lookup)\b/.test(normalized)) return "research";
  if (category === "dependency_error" || category === "environment_error") return "terminal";
  if (category === "permission_error") return "security";
  if (category === "network_error") return "research";
  if (category === "incomplete_solution" || category === "wrong_assumption") return "planning";
  if (category === "syntax_error" || category === "type_error" || category === "runtime_error") return "debugging";
  return "inspection";
}

function policyFailure(category: FailureCategory): "test" | "build" | "dependency" | "permission" | "integration" | "unknown" {
  if (category === "dependency_error" || category === "environment_error") return "dependency";
  if (category === "permission_error") return "permission";
  if (category === "syntax_error" || category === "type_error") return "build";
  if (category === "runtime_error" || category === "incomplete_solution") return "test";
  if (category === "network_error" || category === "tool_error") return "integration";
  return "unknown";
}

function policyToLegacy(skill: PolicySkill): SofiaSkill {
  const categoryMap: Record<string, FailureCategory> = {
    test: "runtime_error",
    build: "type_error",
    dependency: "dependency_error",
    permission: "permission_error",
    integration: "tool_error",
    unknown: "unknown",
  };
  const verification: SofiaSkill["verification"] = skill.verification.flatMap((item) => {
    if (item === "tests") return ["test"] as const;
    if (item === "typecheck" || item === "build") return [item] as const;
    return [];
  });
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    triggers: skill.triggers,
    categories: skill.id === "sofia.v1.plan" ? [] : skill.failureCategories.map((item) => categoryMap[item]!),
    strategy: skill.strategy,
    procedure: skill.procedure,
    verification,
    preconditions: skill.preconditions,
    failureConditions: skill.failureConditions,
    recovery: skill.recovery,
    risk: skill.risk === "read" ? "read-only" : "may-write",
    riskLevel: skill.risk,
    requiredCapabilities: skill.requiredCapabilities,
    requiredPermissions: skill.requiredPermissions,
    resourceLimits: skill.resourceLimits,
    retryLimit: skill.retryLimit,
    compatibility: skill.compatibility,
    trustLevel: skill.trustLevel,
    provenance: skill.provenance,
  };
}

export function matchSkills(
  category: FailureCategory,
  message: string,
  limit = 3,
  ledger?: SkillLedger,
): SofiaSkill[] {
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(8, Math.floor(limit))) : 3;
  const safeMessage = typeof message === "string" ? message.slice(0, 4000) : "";
  const lower = safeMessage.toLowerCase();
  let learned: LearnedSkillCandidate[] = [];
  try {
    const entries = ledger?.list() ?? [];
    learned = Array.isArray(entries) ? entries.filter(isSafeLearnedCandidate) : [];
  } catch {
    // An unavailable or malformed learning ledger must not block recovery.
  }
  const legacy = [
    ...BUILTIN_SKILLS,
    ...learned.map(learnedToSkill),
  ];
  // Candidate discovery only: this legacy adapter supplies the catalog vocabulary, not an attestation.
  // ToolGateway remains the authority for actual capabilities and every dispatched action.
  const selectedPolicy = selectPolicySkills({
    text: safeMessage,
    taskType: policyTaskType(category, safeMessage),
    failureCategory: policyFailure(category),
  }, POLICY_CAPABILITIES, boundedLimit);
  const policyById = new Map<string, number>();
  for (const item of selectedPolicy) policyById.set(item.skill.id, item.score);
  const policySkills = POLICY_SKILLS
    .filter((skill) => policyById.has(skill.id))
    .map(policyToLegacy);
  const all = [...legacy, ...policySkills];
  const seen = new Set<string>();
  return all
    .map((skill) => {
      const policyScore = policyById.get(skill.id);
      if (policyScore !== undefined) return { skill, score: policyScore };
      const legacyScore =
        (skill.categories.includes(category) ? 100 : 0) +
        skill.triggers.filter((trigger) => lower.includes(trigger.toLowerCase())).length * 10;
      return { skill, score: legacyScore };
    })
    .filter((item) => item.score > 0 && !seen.has(item.skill.id) && !!seen.add(item.skill.id))
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
    .slice(0, boundedLimit)
    .map((item) => item.skill);
}

function isSafeLearnedCandidate(value: LearnedSkillCandidate): boolean {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (!Object.values(descriptors).every((descriptor) => "value" in descriptor)) return false;
    const categories: readonly string[] = [
      "syntax_error", "type_error", "runtime_error", "dependency_error", "permission_error",
      "network_error", "tool_error", "wrong_assumption", "incomplete_solution",
      "environment_error", "unknown",
    ];
    const strategies: readonly string[] = [
      "initial", "inspect-evidence", "fix-implementation", "fix-environment", "alternative-tool",
    ];
    return typeof value.name === "string" && value.name.length > 0 && value.name.length <= 100 &&
      typeof value.trigger === "string" && value.trigger.length > 0 && value.trigger.length <= 240 &&
      categories.includes(value.category) && strategies.includes(value.strategy) &&
      Array.isArray(value.procedure) && value.procedure.length > 0 && value.procedure.length <= 8 &&
      value.procedure.every((item) => typeof item === "string" && item.length > 0 && item.length <= 240) &&
      Array.isArray(value.verification) && value.verification.length <= 8 &&
      value.verification.every((item) => typeof item === "string" && ["typecheck", "test", "build"].includes(item)) &&
      Array.isArray(value.evidenceIds) && value.evidenceIds.length > 0 && value.evidenceIds.length <= 32 &&
      value.evidenceIds.every((item) => typeof item === "string" && item.length > 0 && item.length <= 128);
  } catch {
    return false;
  }
}

export function compactSkillContext(skills: readonly SofiaSkill[]): unknown[] {
  return skills.map((skill) => ({
    id: skill.id,
    strategy: skill.strategy,
    procedure: skill.procedure,
    verification: skill.verification,
    ...(skill.preconditions ? { preconditions: skill.preconditions } : {}),
    ...(skill.failureConditions ? { failureConditions: skill.failureConditions } : {}),
    ...(skill.recovery ? { recovery: skill.recovery } : {}),
    ...(skill.risk ? { risk: skill.risk } : {}),
    ...(skill.riskLevel ? { riskLevel: skill.riskLevel } : {}),
    ...(skill.requiredCapabilities ? { requiredCapabilities: skill.requiredCapabilities } : {}),
    ...(skill.requiredPermissions ? { requiredPermissions: skill.requiredPermissions } : {}),
    ...(skill.resourceLimits ? { resourceLimits: skill.resourceLimits } : {}),
    ...(skill.retryLimit !== undefined ? { retryLimit: skill.retryLimit } : {}),
    ...(skill.compatibility ? { compatibility: skill.compatibility } : {}),
    ...(skill.trustLevel ? { trustLevel: skill.trustLevel } : {}),
    ...(skill.provenance ? { provenance: skill.provenance } : {}),
  }));
}

export function allBuiltinSkills(): SofiaSkill[] {
  return [...BUILTIN_SKILLS];
}
