import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DesktopDeviceEnrollmentService,
  type DesktopEnrollmentChallenge,
  type DesktopEnrollmentChallengeStore,
} from "../../src/desktop/device-enrollment.js";
import { DesktopDeviceCredentialVault, type DesktopDeviceRecord, type DesktopDeviceRegistryStore } from "../../src/desktop/device-registry.js";

class Challenges implements DesktopEnrollmentChallengeStore {
  readonly entries = new Map<string, DesktopEnrollmentChallenge>();
  async create(hash: string, challenge: DesktopEnrollmentChallenge): Promise<void> {
    if (this.entries.has(hash)) throw new Error("duplicate challenge");
    this.entries.set(hash, challenge);
  }
  async consume(hash: string): Promise<DesktopEnrollmentChallenge | null> {
    const value = this.entries.get(hash) ?? null;
    this.entries.delete(hash);
    return value;
  }
}
class Registry implements DesktopDeviceRegistryStore {
  readonly records = new Map<string, DesktopDeviceRecord>();
  async create(record: DesktopDeviceRecord): Promise<void> {
    if (this.records.has(record.id)) throw new Error("duplicate device");
    this.records.set(record.id, record);
  }
  async getOwned(owner: string, id: string): Promise<DesktopDeviceRecord | null> {
    const record = this.records.get(id);
    return record?.ownerId === owner ? record : null;
  }
  async listOwned(owner: string): Promise<readonly DesktopDeviceRecord[]> {
    return [...this.records.values()].filter((record) => record.ownerId === owner);
  }
  async revokeOwned(owner: string, id: string, at: number): Promise<boolean> {
    const record = await this.getOwned(owner, id);
    if (!record || record.revokedAt !== undefined) return false;
    this.records.set(id, { ...record, revokedAt: at });
    return true;
  }
}
const key = Buffer.alloc(32, 7);
const secret = Buffer.alloc(32, 9);
const setup = () => {
  let now = 1_700_000_000_000;
  const challenges = new Challenges();
  const registry = new Registry();
  const vault = new DesktopDeviceCredentialVault({ masterKey: key });
  const service = new DesktopDeviceEnrollmentService({
    registry, challenges, vault, now: () => now,
    createDeviceId: () => "desktop-device-0001",
  });
  return { service, challenges, registry, vault, setNow: (value: number) => { now = value; } };
};

test("desktop enrollment binds device to owner and encrypts secret at rest", async () => {
  const { service, challenges, registry, vault } = setup();
  const started = await service.start("owner-1");
  assert.equal(started.code.length, 43);
  assert.equal(challenges.entries.size, 1);
  assert.equal([...challenges.entries.keys()][0], createHash("sha256").update(started.code).digest("hex"));
  const completed = await service.complete({
    code: started.code, displayName: "My PC",
    capabilities: ["system:discover", "workspace:list"], deviceSecret: secret,
  });
  assert.equal(completed.device.ownerId, "owner-1");
  assert.notEqual(completed.device.credential.ciphertext, secret.toString("base64url"));
  assert.deepEqual(vault.decrypt(completed.device.id, "owner-1", completed.device.credential), secret);
  assert.equal((await registry.getOwned("owner-2", completed.device.id)), null);
});

test("desktop enrollment code is single-use even when completion is replayed", async () => {
  const { service, registry } = setup();
  const started = await service.start("owner-1");
  const input = { code: started.code, displayName: "My PC", capabilities: ["system:discover"] as const, deviceSecret: secret };
  await service.complete(input);
  await assert.rejects(service.complete(input), /Invalid or expired/);
  assert.equal(registry.records.size, 1);
});

test("desktop enrollment rejects expired codes and unsafe capabilities", async () => {
  const { service, setNow } = setup();
  const expired = await service.start("owner-1");
  setNow(expired.expiresAt);
  await assert.rejects(service.complete({
    code: expired.code, displayName: "My PC", capabilities: [], deviceSecret: secret,
  }), /Invalid or expired/);

  const { service: other } = setup();
  const started = await other.start("owner-1");
  await assert.rejects(other.complete({
    code: started.code, displayName: "My PC", capabilities: ["process:execute", "arbitrary:admin"] as never,
    deviceSecret: secret,
  }), /Invalid desktop device capabilities/);
});
