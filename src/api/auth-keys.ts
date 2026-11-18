/**
 * Build the API key registry from the primary service key and optional
 * additional scoped keys. Additional keys are used for isolated messaging
 * identities and must remain server-side environment secrets.
 */
export function loadApiKeyScopes(
  primaryApiKey: string,
  primaryScopes: readonly string[],
  additionalJson?: string,
): Record<string, string[]> {
  if (typeof primaryApiKey !== "string" || !primaryApiKey.trim() ||
      primaryApiKey !== primaryApiKey.trim() || primaryApiKey.length > 4_096) {
    throw new Error("SOFIA_API_KEY must be a non-empty trimmed key.");
  }
  const result: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const normalizeScopes = (value: readonly unknown[], allowEmpty: boolean): string[] => {
    if (value.length > 128 || (!allowEmpty && value.length === 0) ||
        !value.every((scope) => typeof scope === "string" && scope.length > 0 &&
          scope.length <= 128 && scope.trim() === scope && !/[\r\n\0]/.test(scope))) {
      throw new Error("API key scopes must be a bounded list of valid strings.");
    }
    return [...new Set(value as string[])];
  };
  result[primaryApiKey] = normalizeScopes(primaryScopes, true);
  if (additionalJson === undefined || additionalJson.trim() === "") return result;
  if (additionalJson.length > 256_000) throw new Error("SOFIA_API_KEYS_JSON is too large.");
  let parsed: unknown;
  try { parsed = JSON.parse(additionalJson); } catch {
    throw new Error("SOFIA_API_KEYS_JSON must contain a valid JSON object.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SOFIA_API_KEYS_JSON must contain a valid JSON object.");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > 1_000) throw new Error("SOFIA_API_KEYS_JSON contains too many keys.");
  for (const [apiKey, scopes] of entries) {
    if (!apiKey || apiKey.trim() !== apiKey || apiKey.length > 4_096 ||
        Object.prototype.hasOwnProperty.call(result, apiKey) ||
        !Array.isArray(scopes)) {
      throw new Error("SOFIA_API_KEYS_JSON contains an invalid or duplicate API key.");
    }
    result[apiKey] = normalizeScopes(scopes, false);
  }
  return result;
}
