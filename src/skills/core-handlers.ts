import type { FailureCategory, Strategy } from "../brain/types.js";
import { ADVANCED_SKILLS, getAdvancedSkill } from "./advanced-skill-catalog.js";
import type { AdvancedSkillHandler } from "./advanced-skill-runtime.js";
import { AdvancedSkillRegistry } from "./advanced-skill-runtime.js";

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Skill input must be an object.");
  }
  return value as RecordValue;
}

function requiredString(record: RecordValue, key: string, maxLength = 4_000): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Skill input ${key} must be a non-empty string.`);
  }
  if (value.length > maxLength) throw new RangeError(`Skill input ${key} exceeds ${maxLength} characters.`);
  return value.trim();
}

function stringArray(value: unknown, key: string, maxItems = 40): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems ||
      value.some(item => typeof item !== "string" || !item.trim() || item.length > 1_000)) {
    throw new TypeError(`Skill input ${key} must be an array of at most ${maxItems} non-empty strings.`);
  }
  return value.map(item => (item as string).trim());
}

const FAILURE_CATEGORIES: readonly FailureCategory[] = [
  "syntax_error", "type_error", "runtime_error", "dependency_error",
  "permission_error", "network_error", "tool_error", "wrong_assumption",
  "incomplete_solution", "environment_error", "unknown",
];

function isFailureCategory(value: unknown): value is FailureCategory {
  return typeof value === "string" && FAILURE_CATEGORIES.includes(value as FailureCategory);
}

/** Deterministic clarification hints; it does not invent missing user intent. */
export const intentClarifier = (input: unknown) => {
  const value = asRecord(input);
  const goal = requiredString(value, "goal");
  const context = typeof value.context === "string" ? value.context.trim().slice(0, 4_000) : "";
  const constraints = stringArray(value.constraints, "constraints");
  const missingInformation: string[] = [];
  if (goal.length < 12 || /^(fix it|do it|make it better|improve this|help me)$/i.test(goal)) {
    missingInformation.push("Specify the target or desired outcome.");
  }
  if (/\b(it|this|that|thing|stuff)\b/i.test(goal) && !context) {
    missingInformation.push("Identify what the pronoun refers to or provide relevant context.");
  }
  if (/\b(best|better|fast|cheap|secure)\b/i.test(goal) && !/\b(than|under|within|at least|must|should|target)\b/i.test(goal)) {
    missingInformation.push("Define measurable success criteria or constraints.");
  }
  return {
    normalizedGoal: goal.replace(/\s+/g, " "),
    constraints,
    contextProvided: Boolean(context),
    missingInformation,
    readyToPlan: missingInformation.length === 0,
  };
};

/** Splits explicit user-provided task boundaries; it never claims semantic decomposition. */
export const goalDecomposer = (input: unknown) => {
  const value = asRecord(input);
  const goal = requiredString(value, "goal");
  const supplied = stringArray(value.subtasks, "subtasks");
  const parts = supplied.length
    ? supplied
    : goal.split(/\n+|\s*;\s*|\s+then\s+/i).map(part => part.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim()).filter(Boolean);
  const subtasks = [...new Set(parts)].slice(0, 40);
  return {
    goal,
    subtasks: subtasks.length ? subtasks : [goal],
    decompositionMethod: supplied.length ? "user-provided" : (subtasks.length > 1 ? "explicit-delimiters" : "single-goal"),
    requiresHumanReview: subtasks.length <= 1,
  };
};

export const planBuilder = (input: unknown) => {
  const value = asRecord(input);
  const steps = stringArray(value.steps, "steps");
  if (steps.length === 0) throw new TypeError("Skill input steps must contain at least one step.");
  const acceptanceCriteria = stringArray(value.acceptanceCriteria, "acceptanceCriteria");
  return {
    steps: steps.map((objective, index) => ({
      id: `step-${index + 1}`,
      objective,
      dependencies: index === 0 ? [] : [`step-${index}`],
      verificationRequired: true,
    })),
    acceptanceCriteria,
    sequential: true,
    stepCount: steps.length,
  };
};

const RETRY_STRATEGIES: Record<FailureCategory, Strategy> = {
  syntax_error: "fix-implementation",
  type_error: "fix-implementation",
  runtime_error: "inspect-evidence",
  dependency_error: "fix-environment",
  permission_error: "inspect-evidence",
  network_error: "alternative-tool",
  tool_error: "alternative-tool",
  wrong_assumption: "initial",
  incomplete_solution: "inspect-evidence",
  environment_error: "fix-environment",
  unknown: "inspect-evidence",
};

export const retryStrategist = (input: unknown) => {
  const value = asRecord(input);
  const category = value.category;
  if (!isFailureCategory(category)) throw new TypeError("Skill input category is not a recognized failure category.");
  const attempts = value.attempts ?? 0;
  const maxAttempts = value.maxAttempts ?? 3;
  if (!Number.isSafeInteger(attempts) || (attempts as number) < 0) throw new RangeError("attempts must be a non-negative integer.");
  if (!Number.isSafeInteger(maxAttempts) || (maxAttempts as number) < 1 || (maxAttempts as number) > 5) {
    throw new RangeError("maxAttempts must be an integer from 1 to 5.");
  }
  const strategy = category === "wrong_assumption" ? "initial" : RETRY_STRATEGIES[category];
  const retry = category !== "permission_error" && (attempts as number) < (maxAttempts as number);
  return {
    retry,
    strategy,
    attempts: attempts as number,
    maxAttempts: maxAttempts as number,
    reason: category === "permission_error"
      ? "Do not retry a permission denial; request authorized access or change the plan."
      : retry ? `Use strategy ${strategy} and verify the result before another retry.` : "Retry budget exhausted; stop and report the remaining failure.",
  };
};

const FAILURE_PATTERNS: ReadonlyArray<{ category: FailureCategory; pattern: RegExp }> = [
  { category: "permission_error", pattern: /permission denied|not authorized|forbidden|approval required|access denied/i },
  { category: "network_error", pattern: /network|econnreset|enotfound|fetch failed|timed? ?out|http [45]\d\d/i },
  { category: "dependency_error", pattern: /cannot find module|module not found|missing dependency|package .* not found/i },
  { category: "type_error", pattern: /type error|not assignable|type .* is not assignable|property .* does not exist/i },
  { category: "syntax_error", pattern: /syntaxerror|parse error|unexpected token|unterminated/i },
  { category: "environment_error", pattern: /environment|enoent|command not found|executable not found|unsupported platform/i },
  { category: "tool_error", pattern: /unknown tool|tool call failed|invalid tool input|tool execution/i },
  { category: "wrong_assumption", pattern: /wrong assumption|incorrect assumption|misunderstood|not what .* expected/i },
  { category: "incomplete_solution", pattern: /incomplete|not finished|missing acceptance|verification failed|criterion .* failed/i },
  { category: "runtime_error", pattern: /exception|runtime error|uncaught|crashed|stack trace/i },
];

export const failureClassifier = (input: unknown) => {
  const value = asRecord(input);
  const message = requiredString(value, "message", 8_000);
  const match = FAILURE_PATTERNS.find(item => item.pattern.test(message));
  return {
    category: match?.category ?? "unknown",
    confidence: match ? 0.8 : 0.25,
    matchedPattern: match?.pattern.source ?? null,
    messagePreview: message.slice(0, 240),
    needsEvidenceReview: !match || match.category === "unknown",
  };
};

export const completionVerifier = (input: unknown) => {
  const value = asRecord(input);
  if (!Array.isArray(value.criteria) || value.criteria.length === 0 || value.criteria.length > 40) {
    throw new TypeError("Skill input criteria must be a non-empty array of at most 40 criteria.");
  }
  if (!Array.isArray(value.results) || value.results.length > 100) {
    throw new TypeError("Skill input results must be an array of at most 100 verification results.");
  }
  const criteria = value.criteria.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError(`criteria[${index}] must be an object.`);
    const criterion = item as RecordValue;
    return { id: requiredString(criterion, "id", 120), description: requiredString(criterion, "description", 1_000) };
  });
  const results = value.results.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError(`results[${index}] must be an object.`);
    const result = item as RecordValue;
    const criterionId = requiredString(result, "criterionId", 120);
    if (typeof result.passed !== "boolean") throw new TypeError(`results[${index}].passed must be boolean.`);
    return { criterionId, passed: result.passed, evidenceIds: stringArray(result.evidenceIds, `results[${index}].evidenceIds`, 20) };
  });
  const checks = criteria.map(criterion => {
    const evidence = results.filter(result => result.criterionId === criterion.id);
    const passed = evidence.some(result => result.passed && result.evidenceIds.length > 0);
    return {
      criterionId: criterion.id,
      description: criterion.description,
      passed,
      evidenceIds: [...new Set(evidence.filter(result => result.passed).flatMap(result => result.evidenceIds))],
      reason: passed ? "A passing verification result includes evidence." : "No passing verification result with evidence was found.",
    };
  });
  return { completed: checks.every(check => check.passed), checks, passedCount: checks.filter(check => check.passed).length, totalCriteria: checks.length };
};

const CORE_SKILLS: ReadonlyArray<{ id: string; handler: AdvancedSkillHandler }> = [
  { id: "runtime.01", handler: intentClarifier },
  { id: "runtime.02", handler: goalDecomposer },
  { id: "runtime.03", handler: planBuilder },
  { id: "runtime.08", handler: retryStrategist },
  { id: "runtime.09", handler: failureClassifier },
  { id: "runtime.10", handler: completionVerifier },
];

/**
 * Registers only core handlers whose catalog entries have been explicitly
 * promoted to verified after their acceptance tests pass.
 */
export function registerVerifiedCoreSkills(registry: AdvancedSkillRegistry): string[] {
  const registered: string[] = [];
  for (const item of CORE_SKILLS) {
    const definition = getAdvancedSkill(item.id);
    if (!definition || definition.status !== "verified") continue;
    registry.register(definition, item.handler);
    registered.push(item.id);
  }
  return registered;
}

export function listImplementedCoreSkillIds(): string[] {
  return CORE_SKILLS.map(item => item.id).filter(id => {
    const definition = ADVANCED_SKILLS.find(skill => skill.id === id);
    return definition?.status === "implemented" || definition?.status === "verified";
  });
}
