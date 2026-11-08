import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { DesktopCapability } from "./types.js";

const ENVELOPE_VERSION = 1 as const;
const ALGORITHM = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedDesktopDeviceSecret {
  version: typeof ENVELOPE_VERSION;
  algorithm: typeof ALGORITHM;
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface DesktopDeviceRecord {
  id: string;
  ownerId: string;
  displayName: string;
  capabilities: readonly DesktopCapability[];
  credential: EncryptedDesktopDeviceSecret;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
}

/**
 * Persistence boundary for a cloud device registry.
 *
 * Implementations must enforce owner scoping in the storage query itself,
 * atomic uniqueness for device IDs, and durable revocation. Do not implement
 * this contract with process-local memory in a multi-instance deployment.
 */
export interface DesktopDeviceRegistryStore {
  create(record: DesktopDeviceRecord): Promise<void>;
  getOwned(ownerId: string, deviceId: string): Promise<DesktopDeviceRecord | null>;
  listOwned(ownerId: string): Promise<readonly DesktopDeviceRecord[]>;
  revokeOwned(ownerId: string, deviceId: string, revokedAt: number): Promise<boolean>;
}

export interface DesktopDeviceCredentialVaultOptions {
  /** Exactly 32 random bytes from a KMS/envelope-encryption managed key. */
  masterKey: Uint8Array;
}

/**
 * Encrypts per-device HMAC secrets before they enter a registry store.
 * The master key must come from a secret manager/KMS, never from source control,
 * model context, a user-facing API response, or the same database row.
 */
export class DesktopDeviceCredentialVault {
  private readonly masterKey: Buffer;

  constructor(options: DesktopDeviceCredentialVaultOptions) {
    if (!(options.masterKey instanceof Uint8Array) || options.masterKey.byteLength !== KEY_BYTES) {
      throw new Error("Desktop device vault master key must be exactly 32 bytes.");
    }
    this.masterKey = Buffer.from(options.masterKey);
  }

  encrypt(deviceId: string, ownerId: string, secret: Uint8Array): EncryptedDesktopDeviceSecret {
    validateBinding(deviceId, ownerId);
    if (!(secret instanceof Uint8Array) || secret.byteLength < 32 || secret.byteLength > 128) {
      throw new Error("Desktop device secret must contain between 32 and 128 bytes.");
    }

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.masterKey, iv);
    cipher.setAAD(associatedData(deviceId, ownerId));
    const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
    return {
      version: ENVELOPE_VERSION,
      algorithm: ALGORITHM,
      iv: iv.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    };
  }

  decrypt(
    deviceId: string,
    ownerId: string,
    envelope: EncryptedDesktopDeviceSecret,
  ): Buffer {
    validateBinding(deviceId, ownerId);
    if (!envelope || envelope.version !== ENVELOPE_VERSION || envelope.algorithm !== ALGORITHM) {
      throw new Error("Unsupported desktop device credential envelope.");
    }
    const iv = decodeBase64Url(envelope.iv, IV_BYTES, IV_BYTES);
    const ciphertext = decodeBase64Url(envelope.ciphertext, 32, 128);
    const tag = decodeBase64Url(envelope.tag, TAG_BYTES, TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, this.masterKey, iv);
    decipher.setAAD(associatedData(deviceId, ownerId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}

function associatedData(deviceId: string, ownerId: string): Buffer {
  return Buffer.from(["SOFIA-DESKTOP-DEVICE-CREDENTIAL-V1", ownerId, deviceId].join("\n"), "utf8");
}

function validateBinding(deviceId: string, ownerId: string): void {
  if (typeof deviceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(deviceId)) {
    throw new Error("Invalid desktop device ID.");
  }
  if (typeof ownerId !== "string" || ownerId.trim().length === 0 || ownerId.length > 256) {
    throw new Error("Invalid desktop device owner ID.");
  }
}

function decodeBase64Url(value: string, minBytes: number, maxBytes: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Malformed desktop device credential envelope.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength < minBytes || decoded.byteLength > maxBytes ||
      decoded.toString("base64url") !== value) {
    throw new Error("Malformed desktop device credential envelope.");
  }
  return decoded;
}
