import type { WorkspaceRuntime } from "../platform/runtime.js";

export interface ToolContext {
  runtime: WorkspaceRuntime;
  signal?: AbortSignal;
}

export interface SofiaTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<unknown>;
}

export interface ToolRegistry {
  get(name: string): SofiaTool | undefined;
  list(): SofiaTool[];
}

export class MapToolRegistry implements ToolRegistry {
  constructor(private readonly tools: SofiaTool[]) {}
  get(name: string): SofiaTool | undefined { return this.tools.find(tool => tool.name === name); }
  list(): SofiaTool[] { return [...this.tools]; }
}
