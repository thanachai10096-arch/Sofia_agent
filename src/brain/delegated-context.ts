import type { ToolExecutionContext } from "./types.js";

// A WeakSet keeps delegated status out of caller-controlled context properties.
// Only the server-side capability gateway imports the marker function.
const delegatedContexts = new WeakSet<ToolExecutionContext>();

export function markDelegatedExecution(context: ToolExecutionContext): void {
  delegatedContexts.add(context);
}

export function isDelegatedExecution(context: ToolExecutionContext): boolean {
  return delegatedContexts.has(context);
}
