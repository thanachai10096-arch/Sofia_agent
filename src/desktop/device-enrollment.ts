import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DesktopCapability } from "./types.js";
import {
  DesktopDeviceCredentialVault,
  type DesktopDeviceRecord,
  type DesktopDeviceRegistryStore,
} from "./device-registry.js";

const ENROLLMENT_TTL_MS = 5 * 60_000;
const ALLOWED_CAPABILITIES = new Set<DesktopCapability>([
  "system:discover",
  "workspace:list",
  "workspace:read",
  "workspace:write",
  "process:execute",
  "screen:capture",
  "app:launch",
  "input:control",
]);

export interface DesktopEnrollmentChallenge {
  ownerId: string;
  expiresAt: number;
}

export interface DesktopEnrollmentChallengeStore {
  /** Must atomically fail if the token hash already exists. */
  create(tokenHash: string, challenge: DesktopEnrollmentChallenge, ttlSeconds: number): Promise<void>;
  /** Must atomically read and delete a challenge; a token can succeed only once. */
  consume(tokenHash: string): Promise<DesktopEnrollmentChallenge | null>;
}

export interface DesktopDeviceEnrollmentServiceOptions {
  registry: DesktopDeviceRegistryStore;
  challenges: DesktopEnrollmentChallengeStore;
  vault: DesktopDeviceCredentialVault;
  now?: () => number;
  createDeviceId?: () => string;
}

export interface StartedDesktopEnrollment {
  code: string;
  expiresAt: number;
}

export interface CompletedDesktopEnrollment {
  device: DesktopDeviceRecord;
}

/**
 * Coordinates short-lived, single-use pairing. The code is a 256-bit random
 * bearer secret and is returned only when enrollment is initiated by the
 * authenticated owner. The companion must send it over TLS and store its
 * generated device secret in the operating system credential manager.
 */
export class DesktopDeviceEnrollmentService {
  private readonly registry: DesktopDeviceRegistryStore;
  private readonly challenges: DesktopEnrollmentChallengeStore;
  private readonly vault: DesktopDeviceCredentialVault;
  private readonly now: () => number;
  private readonly createDeviceId: () => string;

  constructor(options: DesktopDeviceEnrollmentServiceOptions) {
    this.registry = options.registry;
    this.challenges = options.challenges;
    this.vault = options.vault;
    this.now = options.now ?? Date.now;
    this.createDeviceId = options.createDeviceId ?? randomUUID;
  }

  async start(ownerId: string): Promise<StartedDesktopEnrollment> {
    validateOwner(ownerId);
    const code = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + ENROLLMENT_TTL_MS;
    await this.challenges.create(hashCode(code), { ownerId, expiresAt }, Math.ceil(ENROLLMENT_TTL_MS / 1000));
    return { code, expiresAt };
  }

  async complete(input: {
    code: string;
    displayName: string;
    capabilities: readonly DesktopCapability[];
    deviceSecret: Uint8Array;
  }): Promise<CompletedDesktopEnrollment> {
    if (typeof input.code !== "string" || !/^[A-Za-z0-9_-]{40,64}$/.test(input.code)) {
      throw new Error("Invalid or expired desktop enrollment code.");
    }
    if (!(input.deviceSecret instanceof Uint8Array) || input.deviceSecret.byteLength < 32 || input.deviceSecret.byteLength > 128) {
      throw new Error("Desktop device secret must contain between 32 and 128 bytes.");
    }
    if (typeof input.displayName !== "string" || !input.displayName.trim() || input.displayName.length > 120) {
      throw new Error("Invalid desktop device display name.");
    }
    if (!Array.isArray(input.capabilities) || input.capabilities.length > ALLOWED_CAPABILITIES.size ||
        input.capabilities.some((capability) => !ALLOWED_CAPABILITIES.has(capability)) ||
        new Set(input.capabilities).size !== input.capabilities.length) {
      throw new Error("Invalid desktop device capabilities.");
    }

    // Consume before creating the record: concurrent/replayed completions cannot
    // create multiple devices from one code. Failures require a fresh enrollment.
    const challenge = await this.challenges.consume(hashCode(input.code));
    if (!challenge || challenge.expiresAt <= this.now()) {
      throw new Error("Invalid or expired desktop enrollment code.");
    }
    validateOwner(challenge.ownerId);
    const id = this.createDeviceId();
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(id)) {
      throw new Error("Invalid generated desktop device ID.");
    }
    const record: DesktopDeviceRecord = {
      id,
      ownerId: challenge.ownerId,
      displayName: input.displayName.trim(),
      capabilities: [...input.capabilities],
      credential: this.vault.encrypt(id, challenge.ownerId, input.deviceSecret),
      createdAt: this.now(),
    };
    await this.registry.create(record);
    return { device: record };
  }
}

function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

function validateOwner(ownerId: string): void {
  if (typeof ownerId !== "string" || !ownerId.trim() || ownerId.length > 256) {
    throw new Error("Invalid desktop device owner ID.");
  }
}
