import os from "node:os";
import path from "node:path";

/**
 * Resolve a store-specific directory under SOFIA_STATE_DIR.
 * Without configuration, retain the historical OS-temp location for tests/dev.
 * Production deployments should set SOFIA_STATE_DIR to an absolute persistent path.
 */
export function sofiaStateDirectory(storeName: string): string {
  if (!/^[a-z0-9-]+$/.test(storeName)) {
    throw new Error("Sofia state store names may contain only lowercase letters, digits, and hyphens.");
  }
  const configuredRoot = process.env.SOFIA_STATE_DIR?.trim();
  const root = configuredRoot || os.tmpdir();
  if (!path.isAbsolute(root)) {
    throw new Error("SOFIA_STATE_DIR must be an absolute path.");
  }
  return path.join(root, `sofia-agents-${storeName}`);
}
