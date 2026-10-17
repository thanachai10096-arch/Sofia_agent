import { createHash } from "node:crypto";

/** Stable fingerprint for a validated request, independent of object key order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

export function idempotencyFingerprint(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) throw new Error("Cannot fingerprint an undefined request.");
  return createHash("sha256").update(serialized).digest("hex");
}
