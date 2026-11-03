/** Parse a per-Discord-user Sofia API key map from trusted server configuration. */
export function parseDiscordUserApiKeys(value: string): Map<string, string> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("DISCORD_USER_API_KEYS must be valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DISCORD_USER_API_KEYS must be a JSON object.");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (!entries.length) throw new Error("DISCORD_USER_API_KEYS must not be empty.");
  const keys = new Set<string>();
  const result = new Map<string, string>();
  for (const [userId, apiKey] of entries) {
    if (!/^\d{1,24}$/.test(userId) || typeof apiKey !== "string" ||
        !apiKey || apiKey !== apiKey.trim() || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) {
      throw new Error("DISCORD_USER_API_KEYS contains an invalid user ID or API key.");
    }
    if (keys.has(apiKey)) throw new Error("DISCORD_USER_API_KEYS must use a distinct API key for each Discord user.");
    keys.add(apiKey);
    result.set(userId, apiKey);
  }
  return result;
}

/** Require a one-to-one mapping; extra credentials and missing users both fail closed. */
export function matchDiscordUserApiKeys(
  apiKeys: ReadonlyMap<string, string>,
  allowedUserIds: readonly string[],
  reservedApiKeys: readonly string[] = [],
): boolean {
  const reserved = new Set(reservedApiKeys);
  return allowedUserIds.length > 0 && apiKeys.size === allowedUserIds.length &&
    allowedUserIds.every((userId) => apiKeys.has(userId)) &&
    [...apiKeys.values()].every((apiKey) => !reserved.has(apiKey));
}
