import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface DesktopRelayRequest {
  deviceId: string;
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  body?: string | Uint8Array;
}

export interface DesktopRelayAuthHeaders {
  "x-sofia-device-id": string;
  "x-sofia-timestamp": string;
  "x-sofia-nonce": string;
  "x-sofia-signature": string;
}

export interface DesktopRelayReplayGuardOptions {
  now?: () => number;
  maxEntries?: number;
}

/**
 * Bounded in-memory replay protection for authenticated relay requests.
 * A production multi-instance relay must use a shared atomic nonce store.
 */
export class DesktopRelayReplayGuard {
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly seen = new Map<string, number>();

  constructor(options: DesktopRelayReplayGuardOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = Math.min(Math.max(100, options.maxEntries ?? 10_000), 100_000);
  }

  consume(deviceId: string, nonce: string, expiresAt: number): boolean {
    const now = this.now();
    for (const [key, expiry] of this.seen) {
      if (expiry <= now) this.seen.delete(key);
    }
    const key = deviceId + ":" + nonce;
    if (this.seen.has(key) || this.seen.size >= this.maxEntries) return false;
    this.seen.set(key, expiresAt);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

export function createDesktopRelayNonce(): string {
  return randomBytes(24).toString("base64url");
}

export function signDesktopRelayRequest(
  request: DesktopRelayRequest,
  secret: Uint8Array,
): DesktopRelayAuthHeaders {
  validateRequest(request, secret);
  const timestamp = String(request.timestamp);
  const signature = createHmac("sha256", secret)
    .update(canonicalRequest(request, timestamp), "utf8")
    .digest("hex");
  return {
    "x-sofia-device-id": request.deviceId,
    "x-sofia-timestamp": timestamp,
    "x-sofia-nonce": request.nonce,
    "x-sofia-signature": signature,
  };
}

export function verifyDesktopRelayRequest(
  request: DesktopRelayRequest,
  headers: Partial<DesktopRelayAuthHeaders>,
  secret: Uint8Array,
  replayGuard: DesktopRelayReplayGuard,
  options: { now?: () => number; maxClockSkewMs?: number } = {},
): boolean {
  try {
    validateRequest(request, secret);
    const now = (options.now ?? Date.now)();
    const maxSkew = options.maxClockSkewMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(maxSkew) || maxSkew < 1_000 || maxSkew > 15 * 60_000) return false;
    if (Math.abs(now - request.timestamp) > maxSkew) return false;
    if (headers["x-sofia-device-id"] !== request.deviceId ||
        headers["x-sofia-timestamp"] !== String(request.timestamp) ||
        headers["x-sofia-nonce"] !== request.nonce) return false;
    const supplied = headers["x-sofia-signature"] ?? "";
    if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
    const expected = createHmac("sha256", secret)
      .update(canonicalRequest(request, String(request.timestamp)), "utf8")
      .digest();
    const actual = Buffer.from(supplied, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    return replayGuard.consume(request.deviceId, request.nonce, request.timestamp + maxSkew);
  } catch {
    return false;
  }
}

function validateRequest(request: DesktopRelayRequest, secret: Uint8Array): void {
  if (!(secret instanceof Uint8Array) || secret.byteLength < 32) {
    throw new Error("Desktop relay credentials must contain at least 32 bytes.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(request.deviceId)) {
    throw new Error("Invalid desktop relay device ID.");
  }
  if (!/^[A-Z]{3,10}$/.test(request.method)) throw new Error("Invalid desktop relay method.");
  if (!request.path.startsWith("/") || request.path.startsWith("//") ||
      request.path.includes("#") || request.path.length > 2048) {
    throw new Error("Invalid desktop relay path.");
  }
  if (!Number.isSafeInteger(request.timestamp) || request.timestamp < 0) {
    throw new Error("Invalid desktop relay timestamp.");
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(request.nonce)) {
    throw new Error("Invalid desktop relay nonce.");
  }
}

function canonicalRequest(request: DesktopRelayRequest, timestamp: string): string {
  const body = request.body ?? "";
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return [
    "SOFIA-DESKTOP-RELAY-V1",
    request.deviceId,
    request.method,
    request.path,
    timestamp,
    request.nonce,
    bodyHash,
  ].join("\n");
}
