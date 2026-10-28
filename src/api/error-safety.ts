import { redactSecrets } from "../security/guard.js";

/**
 * Return bounded, redacted diagnostics for API responses and persisted run state.
 * This is defense in depth; secrets should never be included in provider errors.
 */
export function safeErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback;
  const cleaned = String(redactSecrets(raw)).replace(/[\r\n\t]+/g, " ").slice(0, 500).trim();
  return cleaned || fallback;
}
