import assert from "node:assert/strict";
import test from "node:test";
import {
  REDIS_DESKTOP_DEVICE_CREATE_SCRIPT,
  REDIS_DESKTOP_DEVICE_GET_SCRIPT,
  REDIS_DESKTOP_DEVICE_LIST_SCRIPT,
  REDIS_DESKTOP_DEVICE_REVOKE_SCRIPT,
  RedisDesktopDeviceRegistryStore,
} from "../../src/desktop/redis-device-registry-store.js";
import type { DesktopDeviceRecord } from "../../src/desktop/device-registry.js";
import type { RedisEvalClient } from "../../src/integrations/messaging/redis-rate-limiter.js";

class FakeRedis implements RedisEvalClient {
  readonly values = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();
  lastKeys: string[] = [];

  async eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    this.lastKeys = options.keys;
    const [key, secondary] = options.keys;
    if (script === REDIS_DESKTOP_DEVICE_CREATE_SCRIPT) {
      if (this.values.has(key!)) return 0;
      this.values.set(key!, options.arguments[0]!);
      const index = this.sets.get(secondary!) ?? new Set<string>();
      index.add(key!);
      this.sets.set(secondary!, index);
      return 1;
    }
    if (script === REDIS_DESKTOP_DEVICE_GET_SCRIPT) return this.values.get(key!) ?? null;
    if (script === REDIS_DESKTOP_DEVICE_LIST_SCRIPT) {
      return [...(this.sets.get(key!) ?? [])].flatMap((entry) => {
        const value = this.values.get(entry);
        return value === undefined ? [] : [value];
      });
    }
    if (script === REDIS_DESKTOP_DEVICE_REVOKE_SCRIPT) {
      const value = this.values.get(key!);
      if (!value) return 0;
      const record = JSON.parse(value) as DesktopDeviceRecord;
      if (record.ownerId !== options.arguments[0] || record.revokedAt !== undefined) return 0;
      record.revokedAt = Number(options.arguments[1]);
      this.values.set(key!, JSON.stringify(record));
      return 1;
    }
    throw new Error("Unexpected Redis script.");
  }
}

const device = (ownerId: string, id: string): DesktopDeviceRecord => ({
  id,
  ownerId,
  displayName: "Personal desktop",
  capabilities: ["system:discover"],
  credential: {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: Buffer.alloc(12, 1).toString("base64url"),
    ciphertext: Buffer.alloc(32, 2).toString("base64url"),
    tag: Buffer.alloc(16, 3).toString("base64url"),
  },
  createdAt: 1_700_000_000_000,
});

test("Redis device registry creates atomically and scopes reads and lists by owner", async () => {
  const client = new FakeRedis();
  const store = new RedisDesktopDeviceRegistryStore({ client });
  const record = device("owner-alpha", "desktop-device-0001");
  await store.create(record);
  await assert.rejects(store.create(record), /already exists/);
  assert.deepEqual(await store.getOwned(record.ownerId, record.id), record);
  assert.equal(await store.getOwned("owner-beta", record.id), null);
  assert.deepEqual(await store.listOwned(record.ownerId), [record]);
  assert.deepEqual(await store.listOwned("owner-beta"), []);
});

test("Redis device registry revocation is owner-bound, durable and idempotent", async () => {
  const client = new FakeRedis();
  const store = new RedisDesktopDeviceRegistryStore({ client });
  const record = device("owner-alpha", "desktop-device-0002");
  await store.create(record);
  assert.equal(await store.revokeOwned("owner-beta", record.id, 1_700_000_000_100), false);
  assert.equal(await store.revokeOwned(record.ownerId, record.id, 1_700_000_000_100), true);
  assert.equal(await store.revokeOwned(record.ownerId, record.id, 1_700_000_000_200), false);
  assert.equal((await store.getOwned(record.ownerId, record.id))?.revokedAt, 1_700_000_000_100);
  assert.equal((await store.listOwned(record.ownerId))[0]?.revokedAt, 1_700_000_000_100);
});

test("Redis device registry rejects malformed records and invalid timestamps", async () => {
  const store = new RedisDesktopDeviceRegistryStore({ client: new FakeRedis() });
  await assert.rejects(store.create({ ...device("owner-alpha", "desktop-device-0003"), displayName: "" }));
  await assert.rejects(store.revokeOwned("owner-alpha", "desktop-device-0003", -1));
});

test("Redis device record and owner index share a Redis Cluster hash slot", async () => {
  const client = new FakeRedis();
  const store = new RedisDesktopDeviceRegistryStore({ client });
  await store.create(device("owner-cluster", "desktop-device-0004"));
  assert.equal(client.lastKeys.length, 2);
  const recordTag = client.lastKeys[0]?.match(/\{([^}]+)\}/)?.[1];
  const ownerTag = client.lastKeys[1]?.match(/\{([^}]+)\}/)?.[1];
  assert.ok(recordTag);
  assert.equal(recordTag, ownerTag);
});
