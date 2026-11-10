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

/**
 * Revalidate persisted Discord notification routes against the current allowlists.
 * Stored job metadata is not an authorization grant: configuration may have
 * changed since the job was created or before a process restart.
 */
export function isDiscordRecoveryDestinationAllowed(
  ownerKeyId: string | undefined,
  notificationChannelId: string | undefined,
  allowedUserIds: readonly string[],
  allowedChannelIds: readonly string[],
): boolean {
  if (!ownerKeyId?.startsWith("discord:") || !notificationChannelId) return false;
  const userId = ownerKeyId.slice("discord:".length);
  return /^\\d{1,24}$/.test(userId) &&
    allowedUserIds.includes(userId) &&
    /^\\d{1,24}$/.test(notificationChannelId) &&
    allowedChannelIds.includes(notificationChannelId);
}
