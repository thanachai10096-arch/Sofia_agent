import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { Aes256GcmApprovalPayloadCipher } from "./approval-payload-cipher.js";

const context = {
  approvalId: "approval-1",
  principalId: "tenant-a",
  runId: "run-1",
  toolName: "browser.purchase",
  actionHash: "sha256-action",
  expiresAt: 1_900_000_000_000,
};

test("AES-GCM approval payload round-trips without exposing plaintext", () => {
  const cipher = new Aes256GcmApprovalPayloadCipher(randomBytes(32), "primary-v1");
  const secretAction = JSON.stringify({ item: "private item", paymentToken: "never-store-plaintext" });
  const encrypted = cipher.encrypt(secretAction, context);
  assert.equal(cipher.decrypt(encrypted, context), secretAction);
  assert.equal(JSON.stringify(encrypted).includes("never-store-plaintext"), false);
  assert.equal(encrypted.version, 1);
  assert.equal(encrypted.algorithm, "aes-256-gcm");
});

test("AES-GCM approval payload is bound to owner, run, action, tool, and expiry", () => {
  const cipher = new Aes256GcmApprovalPayloadCipher(randomBytes(32), "primary-v1");
  const encrypted = cipher.encrypt("proposed action", context);
  for (const altered of [
    { ...context, principalId: "tenant-b" },
    { ...context, runId: "run-2" },
    { ...context, actionHash: "different-action" },
    { ...context, toolName: "browser.navigate" },
    { ...context, expiresAt: context.expiresAt + 1 },
    { ...context, approvalId: "approval-2" },
  ]) {
    assert.throws(() => cipher.decrypt(encrypted, altered), /Unable to authenticate/);
  }
});

test("AES-GCM approval payload rejects tampering and unknown key IDs", () => {
  const cipher = new Aes256GcmApprovalPayloadCipher(randomBytes(32), "primary-v1");
  const encrypted = cipher.encrypt("proposed action", context);
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
  ciphertext[0] = ciphertext[0]! ^ 1;
  assert.throws(() => cipher.decrypt({ ...encrypted, ciphertext: ciphertext.toString("base64") }, context), /Unable to authenticate/);
  assert.throws(() => cipher.decrypt({ ...encrypted, keyId: "retired-key" }, context), /Invalid encrypted/);
});

test("AES-GCM approval payload validates key material and envelope encoding", () => {
  assert.throws(() => new Aes256GcmApprovalPayloadCipher(randomBytes(31), "primary-v1"), /32 bytes/);
  assert.throws(() => new Aes256GcmApprovalPayloadCipher(randomBytes(32), "bad key id"), /key ID/);
  const cipher = new Aes256GcmApprovalPayloadCipher(randomBytes(32), "primary-v1");
  const encrypted = cipher.encrypt("payload", context);
  assert.throws(() => cipher.decrypt({ ...encrypted, nonce: "not-base64" }, context), /Unable to authenticate/);
  assert.throws(() => cipher.decrypt(encrypted, { ...context, expiresAt: -1 }), /Unable to authenticate/);
});
