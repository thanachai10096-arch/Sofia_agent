import { createHmac, timingSafeEqual } from "node:crypto";

/** Generic HMAC webhook primitives. Provider adapters must follow their exact signing specification. */
export interface WebhookSignatureInput { rawBody: string | Uint8Array; signatureHeader: string; secret: string; now?: number; toleranceSeconds?: number; }
export type WebhookSignatureResult = { valid: true; timestamp: number } | { valid: false; reason: "missing-secret" | "malformed-header" | "stale-timestamp" | "invalid-signature" };

/** Verifies t=<unix-seconds>,v1=<hex> over <timestamp>.<rawBody>; this is not a universal provider format. */
export function verifyHmacWebhookSignature(input: WebhookSignatureInput): WebhookSignatureResult {
  if (!input.secret) return { valid: false, reason: "missing-secret" };
  const match = /^t=(\d+),v1=([a-f\d]{64})$/i.exec(input.signatureHeader.trim());
  if (!match) return { valid: false, reason: "malformed-header" };
  const timestamp = Number(match[1]), now = input.now ?? Date.now(), tolerance = input.toleranceSeconds ?? 300;
  if (!Number.isSafeInteger(timestamp) || !Number.isFinite(now) || !Number.isSafeInteger(tolerance) || tolerance < 0 || Math.abs(Math.floor(now / 1000) - timestamp) > tolerance) return { valid: false, reason: "stale-timestamp" };
  const expected = createHmac("sha256", input.secret).update(String(timestamp) + ".", "utf8").update(input.rawBody).digest();
  const supplied = Buffer.from(match[2]!, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return { valid: false, reason: "invalid-signature" };
  return { valid: true, timestamp };
}

export interface WebhookReplayStore { consumeOnce(eventId: string, expiresAt: number): Promise<boolean> | boolean; }
/** Process-local fallback for tests/single-process use; production needs a durable atomic store. */
export class MemoryWebhookReplayStore implements WebhookReplayStore {
  private readonly seen = new Map<string, number>();
  constructor(private readonly maxEntries = 10_000, private readonly now: () => number = Date.now) { if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be a positive integer."); }
  consumeOnce(eventId: string, expiresAt: number): boolean {
    const id = eventId.trim(); if (!id || !Number.isFinite(expiresAt) || expiresAt <= this.now()) return false;
    const current = this.now(); for (const [key, expiry] of this.seen) if (expiry <= current) this.seen.delete(key);
    if (this.seen.has(id)) return false;
    while (this.seen.size >= this.maxEntries) { const oldest = this.seen.keys().next().value; if (oldest === undefined) break; this.seen.delete(oldest); }
    this.seen.set(id, expiresAt); return true;
  }
}

/** Call only after signature verification; event IDs are reserved once within the signed timestamp window. */
export async function acceptWebhookEvent(store: WebhookReplayStore, eventId: string, verifiedTimestamp: number, toleranceSeconds = 300, now = Date.now()): Promise<boolean> {
  if (!eventId.trim() || !Number.isSafeInteger(verifiedTimestamp) || !Number.isSafeInteger(toleranceSeconds) || toleranceSeconds < 0 || !Number.isFinite(now)) return false;
  if (Math.abs(Math.floor(now / 1000) - verifiedTimestamp) > toleranceSeconds) return false;
  return store.consumeOnce(eventId, (verifiedTimestamp + toleranceSeconds) * 1000);
}
