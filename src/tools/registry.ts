import type { ToolRegistry, SofiaTool } from "./types.js";
import { MapToolRegistry } from "./types.js";

export function createToolRegistry(tools: SofiaTool[]): ToolRegistry {
  return new MapToolRegistry(tools);
}
