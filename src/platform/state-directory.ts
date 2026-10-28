import os from "node:os";
import path from "node:path";

/**
 * Resolve a store-specific directory under SOFIA_STATE_DIR.
 * State is persistent by default under ~/.sofia. Operators may override the root
 * with SOFIA_STATE_DIR to select a mounted persistent volume in hosted deployments.
 */
export function sofiaStateDirectory(storeName: string): string {
  if (!/^[a-z0-9-]+$/.test(storeName)) {
    throw new Error("Sofia state store names may contain only lowercase letters, digits, and hyphens.");
  }
  const configuredRoot = process.env.SOFIA_STATE_DIR?.trim();
  const root = configuredRoot || path.join(os.homedir(), ".sofia");
  if (!path.isAbsolute(root)) {
    throw new Error("SOFIA_STATE_DIR must be an absolute path.");
  }
  return path.join(root, `sofia-agents-${storeName}`);
}
