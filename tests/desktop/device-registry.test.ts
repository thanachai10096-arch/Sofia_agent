import assert from "node:assert/strict";
import test from "node:test";
import { DesktopDeviceCredentialVault } from "../../src/desktop/device-registry.js";

const masterKey = Buffer.alloc(32, 0x31);
const secret = Buffer.alloc(32, 0x72);
const deviceId = "desktop-device-0001";
const ownerId = "account-owner-1";

test("device credential vault encrypts and decrypts a per-device secret", () => {
  const vault = new DesktopDeviceCredentialVault({ masterKey });
  const envelope = vault.encrypt(deviceId, ownerId, secret);
  assert.notEqual(envelope.ciphertext, secret.toString("base64url"));
  assert.deepEqual(vault.decrypt(deviceId, ownerId, envelope), secret);
});

test("device credential envelope is bound to both owner and device identity", () => {
  const vault = new DesktopDeviceCredentialVault({ masterKey });
  const envelope = vault.encrypt(deviceId, ownerId, secret);
  assert.throws(() => vault.decrypt(deviceId, "different-owner", envelope));
  assert.throws(() => vault.decrypt("desktop-device-0002", ownerId, envelope));
});

test("device credential vault rejects tampering and malformed envelopes", () => {
  const vault = new DesktopDeviceCredentialVault({ masterKey });
  const envelope = vault.encrypt(deviceId, ownerId, secret);
  assert.throws(() => vault.decrypt(deviceId, ownerId, { ...envelope, ciphertext: Buffer.alloc(32, 1).toString("base64url") }));
  assert.throws(() => vault.decrypt(deviceId, ownerId, { ...envelope, tag: "invalid!" }));
  assert.throws(() => vault.decrypt(deviceId, ownerId, { ...envelope, version: 2 as 1 }));
});

test("device credential vault rejects weak keys, secrets and invalid ownership", () => {
  assert.throws(() => new DesktopDeviceCredentialVault({ masterKey: Buffer.alloc(16) }), /exactly 32 bytes/);
  const vault = new DesktopDeviceCredentialVault({ masterKey });
  assert.throws(() => vault.encrypt(deviceId, ownerId, Buffer.alloc(16)), /at least 32 bytes/);
  assert.throws(() => vault.encrypt(deviceId, " ", secret), /owner ID/);
  assert.throws(() => vault.encrypt("bad", ownerId, secret), /device ID/);
});
