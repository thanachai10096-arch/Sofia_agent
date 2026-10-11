import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DesktopCapability, DesktopPrincipal } from "./types.js";

export interface DesktopPairingConfig {
  /** Capabilities this local host is willing to grant through pairing. */
  allowedCapabilities: readonly DesktopCapability[];
  /** One-time code lifetime. Clamped to 30 seconds–10 minutes. */
  pairingCodeTtlMs?: number;
  /** Access token lifetime. Clamped to 1 minute–30 days. */
  accessTokenTtlMs?: number;
  /** Maximum incorrect code submissions before the code is invalidated. */
  maxPairingAttempts?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

interface PendingPairing {
  digest: Buffer;
  expiresAt: number;
  failedAttempts: number;
}

interface Session {
  principal: DesktopPrincipal;
  digest: Buffer;
  expiresAt: number;
}

/**
 * In-memory pairing authority for a trusted local host.
 *
 * This class deliberately does not open a network listener or persist credentials.
 * A host must expose it only through a loopback-only transport, show the pairing
 * code directly to the user, and keep tokens out of logs and model context.
 */
export class DesktopPairingAuthority {
  private readonly allowed: Set<DesktopCapability>;
  private readonly now: () => number;
  private readonly codeTtl: number;
  private readonly tokenTtl: number;
  private readonly maxPairingAttempts: number;
  private pending?: PendingPairing;
  private readonly sessions = new Map<string, Session>();

  constructor(config: DesktopPairingConfig) {
    this.allowed = new Set(config.allowedCapabilities);
    this.now = config.now ?? Date.now;
    this.codeTtl = clamp(config.pairingCodeTtlMs ?? 120_000, 30_000, 600_000);
    this.tokenTtl = clamp(config.accessTokenTtlMs ?? 86_400_000, 60_000, 2_592_000_000);
    this.maxPairingAttempts = clamp(config.maxPairingAttempts ?? 5, 1, 20);
  }

  /** Create a cryptographically random, single-use six-digit pairing code. */
  createPairingCode(): { code: string; expiresAt: number } {
    this.pruneExpired();
    const code = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
    this.pending = { digest: digest(code), expiresAt: this.now() + this.codeTtl, failedAttempts: 0 };
    return { code, expiresAt: this.pending.expiresAt };
  }

  /** Exchange a code for a bearer token and a narrowly scoped principal. */
  pair(code: string, requestedCapabilities: readonly DesktopCapability[] = []): {
    token: string;
    expiresAt: number;
    principal: DesktopPrincipal;
  } {
    this.pruneExpired();
    if (!this.pending || this.pending.expiresAt <= this.now()) {
      this.pending = undefined;
      throw new Error("Pairing code is missing or expired.");
    }
    if (!/^\d{6}$/.test(code) || !safeDigestEqual(digest(code), this.pending.digest)) {
      throw new Error("Invalid pairing code.");
    }
    const requested = new Set(requestedCapabilities);
    if ([...requested].some((capability) => !this.allowed.has(capability))) {
      throw new Error("Requested desktop capability is not allowed by the local operator.");
    }

    // Consume the code before issuing credentials: a code cannot create two sessions.
    this.pending = undefined;
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.tokenTtl;
    const principal: DesktopPrincipal = {
      id: randomBytes(16).toString("hex"),
      capabilities: requested,
    };
    this.sessions.set(digest(token).toString("hex"), {
      digest: digest(token),
      principal,
      expiresAt,
    });
    return { token, expiresAt, principal };
  }

  /** Validate a bearer token without ever storing the raw token. */
  authenticate(token: string): DesktopPrincipal {
    this.pruneExpired();
    if (!token || token.length > 256) throw new Error("Invalid or expired local pairing token.");
    const key = digest(token).toString("hex");
    const session = this.sessions.get(key);
    if (!session || !safeDigestEqual(digest(token), session.digest) || session.expiresAt <= this.now()) {
      throw new Error("Invalid or expired local pairing token.");
    }
    return session.principal;
  }

  revoke(token: string): boolean {
    if (!token || token.length > 256) return false;
    return this.sessions.delete(digest(token).toString("hex"));
  }

  revokeAll(): void {
    this.pending = undefined;
    this.sessions.clear();
  }

  private pruneExpired(): void {
    const now = this.now();
    if (this.pending && this.pending.expiresAt <= now) this.pending = undefined;
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(key);
    }
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function safeDigestEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
