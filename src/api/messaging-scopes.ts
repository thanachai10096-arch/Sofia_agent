const ALLOWED_MESSAGING_SCOPES = new Set([
  "agent:run",
  "agent:read",
  "memory:read",
  "memory:write",
  "cron:read",
  "cron:manage",
]);

/**
 * Messaging credentials receive a separate least-privilege scope set.
 * Security-admin and desktop capabilities are intentionally unavailable to chat bridges.
 */
export function parseMessagingApiScopes(value: string | undefined): string[] {
  const raw = value?.trim() || "agent:run,agent:read";
  const scopes = raw.split(",").map((scope) => scope.trim());
  if (!scopes.length || scopes.some((scope) => !scope || !ALLOWED_MESSAGING_SCOPES.has(scope))) {
    throw new Error("SOFIA_MESSAGING_API_SCOPES contains an unsupported scope.");
  }
  if (new Set(scopes).size !== scopes.length) {
    throw new Error("SOFIA_MESSAGING_API_SCOPES must not contain duplicate scopes.");
  }
  return scopes;
}
