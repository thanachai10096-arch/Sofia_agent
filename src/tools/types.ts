import type { WorkspaceRuntime } from "../platform/runtime.js";
import type { ToolEffect } from "../security/policy.js";

export interface ToolContext { runtime: WorkspaceRuntime; signal?: AbortSignal; }
export interface SofiaTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Explicit security effects for policy/approval; inferred from name when omitted. */
  effects?: readonly ToolEffect[];
  execute(input: Record<string, unknown>, context: ToolContext): Promise<unknown>;
}
export interface ToolRegistry { get(name: string): SofiaTool | undefined; list(): SofiaTool[]; }

const validEffects = new Set<ToolEffect>(["read", "write", "shell", "network", "destructive", "browser"]);

function freezeTree<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeTree(child);
  }
  return value;
}

function snapshotTool(tool: SofiaTool): SofiaTool {
  if (!tool.name || !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/.test(tool.name)) {
    throw new Error("Tool name must be a valid non-empty identifier of at most 128 characters.");
  }
  if (!tool.description.trim()) throw new Error("Tool " + tool.name + " must have a description.");
  if (!tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) {
    throw new Error("Tool " + tool.name + " must provide an object input schema.");
  }
  if (typeof tool.execute !== "function") throw new Error("Tool " + tool.name + " must provide an execute function.");
  if (tool.effects?.some((effect) => !validEffects.has(effect))) {
    throw new Error("Tool " + tool.name + " declares an unsupported security effect.");
  }

  // Copy and freeze metadata so registration-time callers cannot rewrite schemas
  // or downgrade effects after the gateway has made its permission decision.
  const inputSchema = freezeTree(structuredClone(tool.inputSchema));
  const effects = tool.effects ? Object.freeze([...new Set(tool.effects)]) : undefined;
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    inputSchema,
    ...(effects ? { effects } : {}),
    execute: tool.execute.bind(tool),
  });
}

export class MapToolRegistry implements ToolRegistry {
  private readonly tools: readonly SofiaTool[];

  constructor(tools: SofiaTool[]) {
    const names = new Set<string>();
    const snapshots = tools.map(snapshotTool);
    for (const tool of snapshots) {
      if (names.has(tool.name)) throw new Error("Duplicate tool name: " + tool.name);
      names.add(tool.name);
    }
    this.tools = Object.freeze(snapshots);
  }

  get(name: string): SofiaTool | undefined { return this.tools.find((tool) => tool.name === name); }
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
  if (expected === "integer" && (typeof value !== "number" || !Number.isInteger(value))) throw new Error(`Invalid tool input at ${path}: expected integer`);
  if (expected === "array" && !Array.isArray(value)) throw new Error(`Invalid tool input at ${path}: expected array`);
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    throw new Error(`Invalid tool input at ${path}: value is not an allowed enum member`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      throw new Error(`Invalid tool input at ${path}: expected at least ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      throw new Error(`Invalid tool input at ${path}: expected at most ${schema.maxItems} items`);
    }
    if (typeof schema.items === "object" && schema.items !== null) {
      const itemSchema = schema.items as Record<string, unknown>;
      value.forEach((item, index) => validateValue(itemSchema, item, `${path}[${index}]`));
    }
  }
  if (validObject) {
    const objectValue = value as Record<string, unknown>;
    const properties = typeof schema.properties === "object" && schema.properties !== null
      ? schema.properties as Record<string, unknown>
      : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === "string" && !Object.prototype.hasOwnProperty.call(objectValue, key)) {
        throw new Error(`Invalid tool input at ${path}: missing required property "${key}"`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(objectValue)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          throw new Error(`Invalid tool input at ${path}: unexpected property "${key}"`);
        }
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(objectValue, key) && typeof childSchema === "object" && childSchema !== null) {
        validateValue(childSchema as Record<string, unknown>, objectValue[key], `${path}.${key}`);
      }
    }
  }
}
