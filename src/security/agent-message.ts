import { createHmac, timingSafeEqual } from "node:crypto";

export type SignedAgentMessage<T = unknown> = {
  messageId: string;
  sender: string;
  recipient: string;
  issuedAt: number;
  nonce: string;
  body: T;
  signature: string;
};

const MAX_FIELD_LENGTH = 512;
const MAX_REPLAY_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_REPLAY_ENTRIES = 100_000;

function canonical(m: Omit<SignedAgentMessage, "signature">): string {
  return JSON.stringify(m);
}

function mac(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function safeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" ||
      !/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  const aa = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return aa.length === 32 && bb.length === 32 && timingSafeEqual(aa, bb);
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_FIELD_LENGTH && value.trim() === value;
}

function validMessage<T>(m: SignedAgentMessage<T>): boolean {
  return !!m && typeof m === "object" &&
    validIdentity(m.messageId) && validIdentity(m.sender) &&
    validIdentity(m.recipient) && validIdentity(m.nonce) &&
    Number.isSafeInteger(m.issuedAt) && m.issuedAt > 0 &&
    typeof m.signature === "string";
}

export function signAgentMessage<T>(
  m: Omit<SignedAgentMessage<T>, "signature">,
  secret: string,
): SignedAgentMessage<T> {
  if (!secret) throw new Error("Agent message secret is required.");
  if (!m || typeof m !== "object" ||
      !validIdentity(m.messageId) || !validIdentity(m.sender) ||
      !validIdentity(m.recipient) || !validIdentity(m.nonce) ||
      !Number.isSafeInteger(m.issuedAt) || m.issuedAt <= 0) {
    throw new Error("Agent message identity and timestamp are invalid.");
  }
  const signature = mac(canonical(m), secret);
  return { ...m, signature };
}

export class ReplayProtector {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 120_000,
    private readonly maxEntries = 10_000,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_REPLAY_TTL_MS) {
      throw new Error("Replay protection TTL must be between 1ms and 24h.");
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 ||
        maxEntries > MAX_REPLAY_ENTRIES) {
      throw new Error("Replay protection capacity must be between 1 and 100000 entries.");
    }
  }

  accept(nonce: string, now = Date.now(), scope = ""): boolean {
    if (!validIdentity(nonce) || !Number.isFinite(now) ||
        typeof scope !== "string" || scope.length > MAX_FIELD_LENGTH) return false;

    for (const [key, expires] of this.seen) {
      if (expires <= now) this.seen.delete(key);
    }

    const key = JSON.stringify([scope, nonce]);
    if (this.seen.has(key)) return false;

    // Never evict an unexpired nonce: doing so would reopen a replay window.
    // Under capacity pressure, reject new messages until entries expire.
    if (this.seen.size >= this.maxEntries) return false;

    const expires = now + this.ttlMs;
    if (!Number.isFinite(expires)) return false;
    this.seen.set(key, expires);
    return true;
  }

  size(): number {
    return this.seen.size;
  }
}

export function verifyAgentMessage<T>(
  m: SignedAgentMessage<T>,
  secret: string,
  maxAgeMs = 120_000,
  expectedRecipient?: string,
  replay?: ReplayProtector,
): boolean {
  if (!secret || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0 ||
      maxAgeMs > MAX_REPLAY_TTL_MS || !validMessage(m)) return false;
  const age = Date.now() - m.issuedAt;
  if (!Number.isFinite(age) || Math.abs(age) > maxAgeMs) return false;
  if (expectedRecipient !== undefined &&
      (!validIdentity(expectedRecipient) || m.recipient !== expectedRecipient)) return false;

  const { signature, ...unsigned } = m;
  let expected: string;
  try {
    expected = mac(canonical(unsigned), secret);
  } catch {
    return false;
  }
  if (!safeEqual(expected, signature)) return false;

  // Scope replay IDs to the authenticated sender and recipient.
  return replay ? replay.accept(m.nonce, Date.now(), JSON.stringify([m.sender, m.recipient])) : true;
}
