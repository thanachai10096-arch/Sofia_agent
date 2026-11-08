/**
 * Parse an explicit Discord ID allowlist.
 *
 * Empty, malformed, or duplicate entries fail closed so a typo cannot silently
 * widen access or make a partially configured integration appear valid.
 */
export function parseDiscordIdAllowlist(value: string | undefined, variableName: string): string[] {
  const entries = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) {
    throw new Error(variableName + " must contain at least one Discord ID.");
  }
  if (entries.some((entry) => !/^\d{1,24}$/.test(entry))) {
    throw new Error(variableName + " contains an invalid Discord ID.");
  }
  if (new Set(entries).size !== entries.length) {
    throw new Error(variableName + " contains duplicate Discord IDs.");
  }
  return entries;
}

/** Check both identities before dispatching any Discord command or chat message. */
export function isDiscordMessageAllowed(input: {
  userId: string;
  channelId: string;
}, allowedUserIds: readonly string[], allowedChannelIds: readonly string[]): boolean {
  return allowedUserIds.includes(input.userId) && allowedChannelIds.includes(input.channelId);
}
