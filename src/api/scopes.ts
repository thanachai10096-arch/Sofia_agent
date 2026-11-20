/**
 * Resolve scopes for the hosted API key.
 * Approval permissions are intentionally excluded unless an operator explicitly opts in.
 */
export function resolveApiScopes(configured?: string): string[] {
  return (configured ?? "agent:run,agent:read")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}
