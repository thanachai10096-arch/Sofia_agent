export interface SessionStoreConfig {
  enabled: boolean;
  databasePath?: string;
}

export interface SessionStoreEnvironment {
  SOFIA_SESSION_STORE?: string;
  SOFIA_SESSION_DB_PATH?: string;
}

/**
 * Resolve opt-in API transcript persistence without changing existing defaults.
 * The legacy database-path variable continues to enable SQLite by itself.
 */
export function resolveSessionStoreConfig(env: SessionStoreEnvironment): SessionStoreConfig {
  const rawMode = env.SOFIA_SESSION_STORE?.trim().toLowerCase();
  const databasePath = env.SOFIA_SESSION_DB_PATH?.trim() || undefined;

  if (rawMode && rawMode !== "sqlite" && rawMode !== "disabled") {
    throw new Error("SOFIA_SESSION_STORE must be either sqlite or disabled.");
  }
  if (rawMode === "disabled" && databasePath) {
    throw new Error("SOFIA_SESSION_DB_PATH cannot be set when SOFIA_SESSION_STORE=disabled.");
  }

  if (rawMode === "sqlite" || databasePath) {
    return { enabled: true, ...(databasePath ? { databasePath } : {}) };
  }
  return { enabled: false };
}
