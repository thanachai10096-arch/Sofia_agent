import type { WorkspaceRuntime } from "../platform/runtime.js";
import type { ToolEffect } from "../security/policy.js";
export interface ToolContext { runtime: WorkspaceRuntime; signal?: AbortSignal; }
export interface SofiaTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Declared capabilities used by the security policy before execution. */
  effects?: readonly ToolEffect[];
  execute(input: Record<string, unknown>, context: ToolContext): Promise<unknown>;
}
export interface ToolRegistry { get(name: string): SofiaTool | undefined; list(): SofiaTool[]; }
export class MapToolRegistry implements ToolRegistry {
  constructor(private readonly tools: SofiaTool[]) {}
  get(name: string): SofiaTool | undefined { return this.tools.find(tool => tool.name === name); }
  list(): SofiaTool[] { return [...this.tools]; }
}