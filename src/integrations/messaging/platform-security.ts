import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";

/** Verify Telegram's configured X-Telegram-Bot-Api-Secret-Token value. */
export function verifyTelegramWebhookSecret(received: string | undefined, expected: string | undefined): boolean {
  if (!received || !expected || received.length > 256 || expected.length > 256) return false;
  const a = createHash("sha256").update(received).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) && received === expected;
}

/** Verify Discord Ed25519 request signatures over timestamp + exact raw request body. */
export function verifyDiscordRequest(input: {
  publicKeyHex: string | undefined;
  signatureHex: string | undefined;
  timestamp: string | undefined;
  rawBody: Uint8Array;
  nowMs?: number;
  maxAgeMs?: number;
}): boolean {
  const { publicKeyHex, signatureHex, timestamp, rawBody } = input;
  if (!publicKeyHex || !signatureHex || !timestamp || !/^[0-9a-f]{64}$/i.test(publicKeyHex) ||
      !/^[0-9a-f]{128}$/i.test(signatureHex) || !/^\d{10,16}$/.test(timestamp) || rawBody.byteLength > 1_000_000) return false;
  const timestampMs = Number(timestamp) * (timestamp.length <= 10 ? 1000 : 1);
  const now = input.nowMs ?? Date.now();
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > (input.maxAgeMs ?? 5 * 60_000)) return false;
  try {
    // RFC 8410 SubjectPublicKeyInfo prefix for a raw Ed25519 public key.
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
    return verify(null, Buffer.concat([Buffer.from(timestamp, "utf8"), Buffer.from(rawBody)]), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

/** Verify Slack Events API signatures over the exact raw request body. */
export function verifySlackRequest(input: {
  signingSecret: string | undefined;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: Uint8Array;
  nowMs?: number;
  maxAgeMs?: number;
}): boolean {
  const { signingSecret, signature, timestamp, rawBody } = input;
  if (!signingSecret || signingSecret.length > 512 || !signature || !/^v0=[0-9a-f]{64}$/i.test(signature) ||
      !timestamp || !/^\d{10}$/.test(timestamp) || rawBody.byteLength > 1_000_000) return false;
  const timestampMs = Number(timestamp) * 1000;
  const now = input.nowMs ?? Date.now();
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > (input.maxAgeMs ?? 5 * 60_000)) return false;
  const base = Buffer.concat([Buffer.from("v0:" + timestamp + ":", "utf8"), Buffer.from(rawBody)]);
  const expected = "v0=" + createHmac("sha256", signingSecret).update(base).digest("hex");
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Safe correlation ID; never use user-provided text as a log field. */
export function safeMessageCorrelationId(platform: string, messageId: string): string {
  return createHash("sha256").update(platform).update("\0").update(messageId).digest("hex").slice(0, 24);
}
