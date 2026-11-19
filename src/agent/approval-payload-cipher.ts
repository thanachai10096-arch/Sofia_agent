import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Immutable metadata authenticated alongside an encrypted proposed action. */
export interface ApprovalPayloadContext {
  approvalId: string;
  principalId: string;
  runId: string;
  toolName: string;
  actionHash: string;
  expiresAt: number;
}

export interface EncryptedApprovalPayload {
  version: 1;
  algorithm: "aes-256-gcm";
  keyId: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}

export interface ApprovalPayloadCipher {
  encrypt(plaintext: string, context: ApprovalPayloadContext): EncryptedApprovalPayload;
  decrypt(payload: EncryptedApprovalPayload, context: ApprovalPayloadContext): string;
}

function contextBytes(context: ApprovalPayloadContext): Buffer {
  if (!context.approvalId || !context.principalId || !context.runId ||
      !context.toolName || !context.actionHash ||
      !Number.isSafeInteger(context.expiresAt) || context.expiresAt < 0) {
    throw new Error("Invalid approval payload context.");
  }
  // An ordered tuple avoids property-order ambiguity and authenticates the
  // payload to its owner, run, action digest, tool, and expiry.
  return Buffer.from(JSON.stringify([
    "sofia-approval-payload-v1",
    context.approvalId,
    context.principalId,
    context.runId,
    context.toolName,
    context.actionHash,
    context.expiresAt,
  ]), "utf8");
}

function decodeBase64(value: string, expectedLength?: number): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid encrypted approval payload.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (expectedLength !== undefined && decoded.length !== expectedLength)) {
    throw new Error("Invalid encrypted approval payload.");
  }
  return decoded;
}

/**
 * AES-256-GCM envelope for sharing pending action payloads between trusted
 * Sofia workers. Keep the 32-byte key outside the database and API responses;
 * use a stable keyId for rotation and retain old decrypt keys only as needed.
 */
export class Aes256GcmApprovalPayloadCipher implements ApprovalPayloadCipher {
  private readonly key: Buffer;

  constructor(key: Uint8Array, readonly keyId: string) {
    if (key.byteLength !== 32) throw new Error("Approval payload encryption key must be exactly 32 bytes.");
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw new Error("Invalid approval payload key ID.");
    this.key = Buffer.from(key);
  }

  encrypt(plaintext: string, context: ApprovalPayloadContext): EncryptedApprovalPayload {
    if (typeof plaintext !== "string") throw new Error("Approval payload must be a string.");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(contextBytes(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      version: 1,
      algorithm: "aes-256-gcm",
      keyId: this.keyId,
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  }

  decrypt(payload: EncryptedApprovalPayload, context: ApprovalPayloadContext): string {
    if (!payload || payload.version !== 1 || payload.algorithm !== "aes-256-gcm" ||
        payload.keyId !== this.keyId || typeof payload.nonce !== "string" ||
        typeof payload.tag !== "string" || typeof payload.ciphertext !== "string") {
      throw new Error("Invalid encrypted approval payload.");
    }
    try {
      const nonce = decodeBase64(payload.nonce, 12);
      const tag = decodeBase64(payload.tag, 16);
      const ciphertext = decodeBase64(payload.ciphertext);
      const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
      decipher.setAAD(contextBytes(context));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      // Do not expose whether the key, context, tag, or ciphertext was wrong.
      throw new Error("Unable to authenticate encrypted approval payload.");
    }
  }
}
