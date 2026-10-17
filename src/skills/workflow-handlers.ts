import { createHash } from "node:crypto";
import { canonicalJson, redactSecrets } from "../security/guard.js";
import { getAdvancedSkill } from "./advanced-skill-catalog.js";
import { AdvancedSkillRegistry, type AdvancedSkillHandler } from "./advanced-skill-runtime.js";

type InputRecord = Record<string, unknown>;
function record(input: unknown): InputRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Skill input must be an object.");
  return input as InputRecord;
}
function objectList(value: unknown, key: string, max = 200): InputRecord[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new TypeError(`Skill input ${key} must be an array of at most ${max} objects.`);
  }
  return value as InputRecord[];
}
function requiredText(value: InputRecord, key: string, max = 1_000): string {
  const item = value[key];
  if (typeof item !== "string" || !item.trim()) throw new TypeError(`Skill input ${key} must be a non-empty string.`);
  if (item.length > max) throw new RangeError(`Skill input ${key} exceeds ${max} characters.`);
  return item.trim();
}
function optionalText(value: InputRecord, key: string, max = 1_000): string | undefined {
  if (value[key] === undefined || value[key] === null || value[key] === "") return undefined;
  return requiredText(value, key, max);
}

/** Builds a dependency-safe workflow order and rejects missing dependencies and cycles. */
export const workflowBuilder = (input: unknown) => {
  const value = record(input);
  const rawSteps = objectList(value.steps, "steps", 100);
  if (rawSteps.length === 0) throw new TypeError("Skill input steps must contain at least one step.");
  const steps = rawSteps.map((step, index) => {
    const id = requiredText(step, "id", 120);
    const action = requiredText(step, "action", 1_000);
    const dependencies = step.dependsOn === undefined ? [] : step.dependsOn;
    if (!Array.isArray(dependencies) || dependencies.length > 100 || dependencies.some(dep => typeof dep !== "string" || !dep.trim())) {
      throw new TypeError(`steps[${index}].dependsOn must be an array of step IDs.`);
    }
    return { id, action, dependsOn: [...new Set(dependencies as string[])] };
  });
  const byId = new Map<string, typeof steps[number]>();
  for (const step of steps) {
    if (byId.has(step.id)) throw new Error(`Duplicate workflow step ID: ${step.id}`);
    byId.set(step.id, step);
  }
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`Unknown dependency ${dependency} referenced by step ${step.id}`);
      if (dependency === step.id) throw new Error(`Workflow step ${step.id} cannot depend on itself`);
    }
  }
  const ordered: typeof steps = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Workflow dependency cycle detected at ${id}`);
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(byId.get(id)!);
  };
  for (const step of steps) visit(step.id);
  return { steps: ordered, stepCount: ordered.length, topologicallyOrdered: true, executesActions: false };
};

/** Evaluates a supplied quota snapshot without maintaining or mutating rate-limit state. */
export const rateLimitManager = (input: unknown) => {
  const value = record(input);
  const used = value.used;
  const limit = value.limit;
  if (!Number.isSafeInteger(used) || (used as number) < 0) throw new RangeError("used must be a non-negative integer.");
  if (!Number.isSafeInteger(limit) || (limit as number) < 1) throw new RangeError("limit must be a positive integer.");
  const now = value.now ?? new Date().toISOString();
  const resetAt = value.resetAt;
  if (typeof now !== "string" || !Number.isFinite(Date.parse(now))) throw new TypeError("now must be a valid date string.");
  if (typeof resetAt !== "string" || !Number.isFinite(Date.parse(resetAt))) throw new TypeError("resetAt must be a valid date string.");
  const allowed = (used as number) < (limit as number);
  const retryAfterSeconds = allowed ? 0 : Math.max(0, Math.ceil((Date.parse(resetAt) - Date.parse(now)) / 1_000));
  return { allowed, used: used as number, limit: limit as number, remaining: Math.max(0, (limit as number) - (used as number)), resetAt, retryAfterSeconds, stateful: false };
};

/** Maps a process into ordered steps, systems, owners, handoffs, and missing metadata. */
export const businessProcessMapper = (input: unknown) => {
  const value = record(input);
  const rawSteps = objectList(value.steps, "steps", 200);
  const steps = rawSteps.map((step, index) => {
    const id = requiredText(step, "id", 120);
    const name = requiredText(step, "name", 500);
    const duration = step.durationMinutes;
    if (duration !== undefined && (!Number.isFinite(duration) || (duration as number) < 0 || (duration as number) > 1_000_000)) {
      throw new RangeError(`steps[${index}].durationMinutes must be a non-negative finite number.`);
    }
    return {
      id, name,
      system: optionalText(step, "system", 200),
      owner: optionalText(step, "owner", 200),
      durationMinutes: duration as number | undefined,
    };
  });
  const handoffs = steps.slice(1).flatMap((step, index) => {
    const previous = steps[index]!;
    return previous.system && step.system && previous.system !== step.system
      ? [{ fromStep: previous.id, toStep: step.id, fromSystem: previous.system, toSystem: step.system }]
      : [];
  });
  return {
    steps,
    systems: [...new Set(steps.map(step => step.system).filter((item): item is string => Boolean(item)))],
    handoffs,
    stepsMissingOwner: steps.filter(step => !step.owner).map(step => step.id),
    stepsMissingSystem: steps.filter(step => !step.system).map(step => step.id),
    totalKnownDurationMinutes: steps.reduce((total, step) => total + (step.durationMinutes ?? 0), 0),
  };
};

/** Compares recorded workflow results; it never replays or executes actions. */
export const workflowReplayTester = (input: unknown) => {
  const value = record(input);
  const expected = objectList(value.expectedSteps, "expectedSteps", 200);
  const actual = objectList(value.actualSteps, "actualSteps", 200);
  const normalize = (items: InputRecord[]) => items.map((item, index) => {
    const id = requiredText(item, "id", 120);
    const status = requiredText(item, "status", 120);
    return { id, status, index, outputHash: optionalText(item, "outputHash", 200) };
  });
  const expectedSteps = normalize(expected);
  const actualSteps = normalize(actual);
  const expectedById = new Map(expectedSteps.map(step => [step.id, step]));
  const actualById = new Map(actualSteps.map(step => [step.id, step]));
  const differences: Array<{ id: string; kind: string; expected?: string; actual?: string }> = [];
  for (const step of expectedSteps) {
    const observed = actualById.get(step.id);
    if (!observed) differences.push({ id: step.id, kind: "missing-step", expected: step.status });
    else if (observed.status !== step.status) differences.push({ id: step.id, kind: "status-mismatch", expected: step.status, actual: observed.status });
    else if (step.outputHash && step.outputHash !== observed.outputHash) {
      differences.push({ id: step.id, kind: "output-mismatch", expected: step.outputHash, actual: observed.outputHash });
    }
  }
  for (const step of actualSteps) if (!expectedById.has(step.id)) differences.push({ id: step.id, kind: "unexpected-step", actual: step.status });
  return { passed: differences.length === 0, differences, expectedStepCount: expectedSteps.length, actualStepCount: actualSteps.length, executedByThisSkill: false };
};

/** Normalizes tool output with secret redaction and a strict size bound. */
export const toolResultNormalizer = (input: unknown) => {
  const value = record(input);
  const toolName = requiredText(value, "toolName", 160);
  const maxChars = value.maxChars ?? 8_000;
  if (!Number.isSafeInteger(maxChars) || (maxChars as number) < 100 || (maxChars as number) > 50_000) {
    throw new RangeError("maxChars must be an integer from 100 to 50000.");
  }
  let serialized: string;
  try { serialized = JSON.stringify(redactSecrets(value.result)) ?? "null"; }
  catch { serialized = "[unserializable tool result]"; }
  const truncated = serialized.length > (maxChars as number);
  const output = truncated ? serialized.slice(0, maxChars as number) : serialized;
  const result = value.result;
  const isError = Boolean(result && typeof result === "object" && !Array.isArray(result) &&
    (((result as Record<string, unknown>).ok === false) || ((result as Record<string, unknown>).error !== undefined)));
  return { toolName: toolName.replace(/[^\w.:-]/g, "_").slice(0, 160), output, truncated, isError, originalChars: serialized.length };
};

export function registerVerifiedWorkflowSkills(registry: AdvancedSkillRegistry): string[] {
  const handlers: Array<{ id: string; handler: AdvancedSkillHandler }> = [
    { id: "workflow.01", handler: workflowBuilder },
    { id: "workflow.06", handler: rateLimitManager },
    { id: "workflow.09", handler: businessProcessMapper },
    { id: "workflow.10", handler: workflowReplayTester },
    { id: "tools.03", handler: toolResultNormalizer },
  ];
  const registered: string[] = [];
  for (const item of handlers) {
    const definition = getAdvancedSkill(item.id);
    if (!definition || definition.status !== "verified") continue;
    registry.register(definition, item.handler);
    registered.push(item.id);
  }
  return registered;
}

export function stableWorkflowFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(redactSecrets(value))).digest("hex");
}
