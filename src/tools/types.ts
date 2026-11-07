import type { WorkspaceRuntime } from "../platform/runtime.js";
import type { ToolEffect } from "../security/policy.js";
export interface ToolApprovalEvidence {
  readonly requestId: string;
  readonly runId: string;
  readonly principalId: string;
  readonly toolName: string;
  readonly actionHash: string;
}
export interface ToolContext { runtime: WorkspaceRuntime; signal?: AbortSignal; approval?: ToolApprovalEvidence; }
export interface SofiaTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Explicit security effects for policy/approval; inferred from name when omitted. */
  effects?: readonly ToolEffect[];
  execute(input: Record<string, unknown>, context: ToolContext): Promise<unknown>;
}
export interface ToolRegistry { get(name: string): SofiaTool | undefined; list(): SofiaTool[]; }
export class MapToolRegistry implements ToolRegistry {
  constructor(private readonly tools: SofiaTool[]) {}
  get(name: string): SofiaTool | undefined { return this.tools.find(tool => tool.name === name); }
  list(): SofiaTool[] { return [...this.tools]; }
}

/** Validate untrusted model-produced arguments against the supported JSON Schema subset. */
export function validateToolInput(schema: Record<string, unknown>, input: Record<string, unknown>): void {
  validateValue(schema, input, "$");
}

function validateValue(schema: Record<string, unknown>, value: unknown, path: string): void {
  const expected = schema.type;
  const validObject = value !== null && typeof value === "object" && !Array.isArray(value);
  if (expected === "object" && !validObject) throw new Error(`Invalid tool input at ${path}: expected object`);
  if (expected === "string" && typeof value !== "string") throw new Error(`Invalid tool input at ${path}: expected string`);
  if (expected === "boolean" && typeof value !== "boolean") throw new Error(`Invalid tool input at ${path}: expected boolean`);
  if (expected === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`Invalid tool input at ${path}: expected finite number`);
  if (expected === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value))) throw new Error(`Invalid tool input at ${path}: expected safe integer`);
  if (expected === "array" && !Array.isArray(value)) throw new Error(`Invalid tool input at ${path}: expected array`);
  if (schema.enum && Array.isArray(schema.enum) && !schema.enum.some(item => Object.is(item, value))) throw new Error(`Invalid tool input at ${path}: value is not allowed`);
  if (validObject) {
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, Record<string, unknown>> : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const key of required) if (!(key in value)) throw new Error(`Invalid tool input at ${path}.${key}: required`);
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in properties)) throw new Error(`Invalid tool input at ${path}.${key}: additional property`);
    for (const [key, child] of Object.entries(properties)) if (key in value) validateValue(child, (value as Record<string, unknown>)[key], `${path}.${key}`);
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === "object") value.forEach((item, index) => validateValue(schema.items as Record<string, unknown>, item, `${path}[${index}]`));
}
