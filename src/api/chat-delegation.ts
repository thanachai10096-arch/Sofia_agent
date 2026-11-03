import { createHmac, timingSafeEqual } from "node:crypto";

export const CHAT_DELEGATION_VERSION = 1 as const;
export const CHAT_DELEGATION_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type DelegatedChatPlatform = "telegram" | "discord" | "slack";

export interface ChatDelegationClaims {
  version: typeof CHAT_DELEGATION_VERSION;
  platform: DelegatedChatPlatform;
  tenantId: string;
  userId: string;
  conversationId: string;
  issuedAt: number;
  nonce: string;
}

export interface ChatDelegationInput {
  platform: DelegatedChatPlatform;
  tenantId: string;
  userId: string;
  conversationId: string;
  issuedAt: number;
  nonce: string;
}

export interface ChatDelegationReplayStore {
  /**
   * Atomically records a nonce until expiresAt. Must return false if the
   * (tenant, platform, nonce) tuple was already claimed.
   * Implementations must be durable/shared when the API runs multiple instances.
   */
  claim(input: {
    tenantId: string;
    platform: DelegatedChatPlatform;
    nonce: string;
    expiresAt: number;
  }): Promise<boolean>;
}

export type ChatDelegationFailure =
  | "invalid_secret"
  | "invalid_claims"
  | "invalid_signature"
  | "expired"
  | "replayed"
  | "replay_store_unavailable";

export type ChatDelegationResult =
  | { ok: true; claims: ChatDelegationClaims; ownerId: string }
  | { ok: false; reason: ChatDelegationFailure };

const ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/;

function validClaims(input: ChatDelegationInput): boolean {
  return (input.platform === "telegram" || input.platform === "discord" || input.platform === "slack") &&
    ID_PATTERN.test(input.tenantId) &&
    ID_PATTERN.test(input.userId) &&
    ID_PATTERN.test(input.conversationId) &&
    NONCE_PATTERN.test(input.nonce) &&
    Number.isSafeInteger(input.issuedAt) && input.issuedAt > 0;
}

/**
 * Stable, versioned serialization. Do not change field order or normalization
 * without incrementing CHAT_DELEGATION_VERSION.
 */
export function canonicalChatDelegation(input: ChatDelegationInput): string {
  return JSON.stringify([
    CHAT_DELEGATION_VERSION,
    input.platform,
    input.tenantId,
    input.userId,
    input.conversationId,
    input.issuedAt,
    input.nonce,
  ]);
}

export function signChatDelegation(input: ChatDelegationInput, secret: string): string {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("Chat delegation secret must contain at least 32 UTF-8 bytes.");
  }
  if (!validClaims(input)) throw new Error("Invalid chat delegation claims.");
  return createHmac("sha256", secret).update(canonicalChatDelegation(input), "utf8").digest("hex");
}

export async function verifyChatDelegation(
  input: ChatDelegationInput,
  signature: string,
  options: {
    secret: string;
    replayStore: ChatDelegationReplayStore;
    now?: number;
    maxClockSkewMs?: number;
  },
): Promise<ChatDelegationResult> {
  const { secret, replayStore } = options;
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    return { ok: false, reason: "invalid_secret" };
  }
  if (!input || typeof input !== "object" || !validClaims(input) ||
      typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature)) {
    return { ok: false, reason: "invalid_claims" };
  }

  const expected = Buffer.from(signChatDelegation(input, secret), "hex");
  const supplied = Buffer.from(signature, "hex");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return { ok: false, reason: "invalid_signature" };
  }

  const now = options.now ?? Date.now();
  const maxClockSkewMs = options.maxClockSkewMs ?? CHAT_DELEGATION_MAX_CLOCK_SKEW_MS;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(maxClockSkewMs) ||
      maxClockSkewMs < 1_000 || maxClockSkewMs > 10 * 60 * 1000 ||
      Math.abs(now - input.issuedAt) > maxClockSkewMs) {
    return { ok: false, reason: "expired" };
  }

  try {
    const claimed = await replayStore.claim({
      tenantId: input.tenantId,
      platform: input.platform,
      nonce: input.nonce,
      expiresAt: input.issuedAt + maxClockSkewMs,
    });
    if (!claimed) return { ok: false, reason: "replayed" };
  } catch {
    return { ok: false, reason: "replay_store_unavailable" };
  }

  const claims: ChatDelegationClaims = { version: CHAT_DELEGATION_VERSION, ...input };
  // The tenant namespace prevents identical platform IDs in different tenants
  // from resolving to the same Memory owner.
  const ownerId = `tenant:${input.tenantId}:${input.platform}:${input.userId}`;
  return { ok: true, claims, ownerId };
}
