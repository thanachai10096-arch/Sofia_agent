import type { ToolRegistry, SofiaTool } from "./types.js";
import { MapToolRegistry } from "./types.js";
export function createToolRegistry(tools: SofiaTool[]): MapToolRegistry { return new MapToolRegistry(tools); }