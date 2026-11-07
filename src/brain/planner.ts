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

function receivedType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function object(value: unknown, field = "value"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid field "${field}": expected object; received type ${receivedType(value)}.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field = "value"): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid field "${field}": expected non-empty string; received type ${receivedType(value)}.`);
  }
  return value;
}

function texts(value: unknown, field = "value"): string[] {
  // Models occasionally emit a single string for a list-valued field even
  // when the JSON contract explicitly requires an array. Normalize that
  // harmless singleton shape at the parser boundary; keep rejecting other
  // types so malformed or unsafe structures do not pass validation.
  if (typeof value === "string") {
    return value.trim() ? [text(value, field)] : [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Invalid field "${field}": expected string array; received type ${receivedType(value)}.`);
  }
  return value.map((item, index) => text(item, `${field}[${index}]`));
}

export function parseUnderstanding(value: unknown): TaskUnderstanding {
  const input = object(value, "understanding");

  if (input.risk !== "low" && input.risk !== "medium" && input.risk !== "high") {
    throw new Error(
      `Invalid field "risk": expected "low" | "medium" | "high"; received type ${receivedType(input.risk)}.`,
    );
  }

  if (input.mode !== undefined && input.mode !== "conversation" && input.mode !== "action") {
    throw new Error('Invalid field "mode": expected "conversation" or "action".');
  }

  return {
    ...(input.mode === "conversation" || input.mode === "action" ? { mode: input.mode } : {}),
    ...(typeof input.response === "string" && input.response.trim() ? { response: input.response.trim().slice(0, 12_000) } : {}),
    objective: text(input.objective, "objective"),
    constraints: texts(input.constraints, "constraints"),
    assumptions: texts(input.assumptions, "assumptions"),
    requiredCapabilities: texts(input.requiredCapabilities, "requiredCapabilities"),
    requiredTools: texts(input.requiredTools, "requiredTools"),
    risk: input.risk,
    successCriteria: texts(input.successCriteria, "successCriteria"),
    ambiguities: texts(input.ambiguities, "ambiguities"),
  };
}

export function parsePlan(value: unknown, maxSteps: number): ExecutionPlan {
  const input = object(value, "plan");

  if (!STRATEGIES.has(input.strategy as Strategy)) {
    throw new Error(`Invalid field "strategy": expected a supported strategy; received type ${receivedType(input.strategy)}.`);
  }

  if (
    !Array.isArray(input.steps) ||
    input.steps.length === 0 ||
    input.steps.length > maxSteps
  ) {
    throw new Error(`Invalid field "steps": expected an array with 1 to ${maxSteps} entries; received type ${receivedType(input.steps)}.`);
  }

  const steps: PlanStep[] = input.steps.map((raw) => {
    const step = object(raw, "steps[]");
    const call = object(step.call, "steps[].call");

    return {
      id: text(step.id, "steps[].id"),
      objective: text(step.objective, "steps[].objective"),
      dependencies: texts(step.dependencies, "steps[].dependencies"),
      call: {
        tool: text(call.tool, "steps[].call.tool"),
        input: object(call.input, "steps[].call.input"),
      },
    };
  });

  const plan: ExecutionPlan = {
    strategy: input.strategy as Strategy,
    reason: text(input.reason, "reason"),
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
