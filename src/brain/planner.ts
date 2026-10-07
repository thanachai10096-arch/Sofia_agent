import { createHash } from "node:crypto";

import type {
  ExecutionPlan,
  PlanStep,
  Strategy,
  TaskUnderstanding,
} from "./types.js";

const STRATEGIES = new Set<Strategy>([
  "initial",
  "inspect-evidence",
  "fix-implementation",
  "fix-environment",
  "alternative-tool",
]);

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Expected a non-empty string");
  }
  return value;
}

function texts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected a string array");
  }
  return value.map(text);
}

export function parseUnderstanding(value: unknown): TaskUnderstanding {
  const input = object(value);

  if (input.risk !== "low" && input.risk !== "medium" && input.risk !== "high") {
    throw new Error("Invalid task risk");
  }

  return {
    objective: text(input.objective),
    constraints: texts(input.constraints),
    assumptions: texts(input.assumptions),
    requiredCapabilities: texts(input.requiredCapabilities),
    requiredTools: texts(input.requiredTools),
    risk: input.risk,
    successCriteria: texts(input.successCriteria),
    ambiguities: texts(input.ambiguities),
  };
}

export function parsePlan(value: unknown, maxSteps: number): ExecutionPlan {
  const input = object(value);

  if (!STRATEGIES.has(input.strategy as Strategy)) {
    throw new Error("Invalid recovery strategy");
  }

  if (
    !Array.isArray(input.steps) ||
    input.steps.length === 0 ||
    input.steps.length > maxSteps
  ) {
    throw new Error("Invalid plan size");
  }

  const steps: PlanStep[] = input.steps.map((raw) => {
    const step = object(raw);
    const call = object(step.call);

    return {
      id: text(step.id),
      objective: text(step.objective),
      dependencies: texts(step.dependencies),
      call: {
        tool: text(call.tool),
        input: object(call.input),
      },
    };
  });

  const plan: ExecutionPlan = {
    strategy: input.strategy as Strategy,
    reason: text(input.reason),
    steps,
  };

  topologicalOrder(plan);
  return plan;
}

export function topologicalOrder(plan: ExecutionPlan): PlanStep[] {
  const byId = new Map<string, PlanStep>();

  for (const step of plan.steps) {
    if (byId.has(step.id)) {
      throw new Error(`Duplicate step: ${step.id}`);
    }
    byId.set(step.id, step);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: PlanStep[] = [];

  function visit(id: string): void {
    if (visiting.has(id)) {
      throw new Error(`Circular dependency: ${id}`);
    }
    if (visited.has(id)) return;

    const step = byId.get(id);
    if (!step) {
      throw new Error(`Unknown dependency: ${id}`);
    }

    visiting.add(id);
    for (const dependency of step.dependencies) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(step);
  }

  for (const step of plan.steps) {
    visit(step.id);
  }

  return ordered;
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  const record = value as Record<string, unknown>;

  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function planFingerprint(plan: ExecutionPlan): string {
  const ordered = topologicalOrder(plan);
  const positions = new Map(ordered.map((step, index) => [step.id, index]));

  return digest(
    ordered.map((step) => ({
      call: step.call,
      dependencies: step.dependencies
        .map((id) => positions.get(id)!)
        .sort((a, b) => a - b),
    })),
  );
}
