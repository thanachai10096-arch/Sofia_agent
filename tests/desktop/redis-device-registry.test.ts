import assert from "node:assert/strict";
import test from "node:test";
import type { RedisEvalClient } from "../../src/integrations/messaging/redis-rate-limiter.js";
import {
  REDIS_DESKTOP_DEVICE_CREATE_SCRIPT,
  REDIS_DESKTOP_DEVICE_GET_SCRIPT,
  REDIS_DESKTOP_DEVICE_LIST_SCRIPT,
  REDIS_DESKTOP_DEVICE_REVOKE_SCRIPT,
  RedisDesktopDeviceRegistryStore,
} from "../../src/desktop/redis-device-registry.js";
import type { DesktopDeviceRecord } from "../../src/desktop/device-registry.js";

function memoryRedis(): RedisEvalClient {
  const values = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    async eval(script, { keys, arguments: args }) {
      if (script === REDIS_DESKTOP_DEVICE_CREATE_SCRIPT) {
        const [deviceKey, indexKey] = keys;
        const [value, limitText] = args;
        if (values.has(deviceKey!)) return 0;
        const index = sets.get(indexKey!) ?? new Set<string>();
        if (index.size >= Number(limitText)) return -1;
        values.set(deviceKey!, value!);
        index.add(deviceKey!);
        sets.set(indexKey!, index);
        return 1;
      }
      if (script === REDIS_DESKTOP_DEVICE_GET_SCRIPT) {
        const value = values.get(keys[0]!);
        if (!value) return null;
        const record = JSON.parse(value) as DesktopDeviceRecord;
        return record.ownerId === args[0] && record.id === args[1] ? value : null;
      }
      if (script === REDIS_DESKTOP_DEVICE_LIST_SCRIPT) {
        const index = sets.get(keys[0]!) ?? new Set<string>();
        return [...index].flatMap((key) => {
          const value = values.get(key);
          if (!value) { index.delete(key); return []; }
          const record = JSON.parse(value) as DesktopDeviceRecord;
          if (record.ownerId !== args[0]) { index.delete(key); return []; }
          return [value];
        });
      }
      if (script === REDIS_DESKTOP_DEVICE_REVOKE_SCRIPT) {
        const value = values.get(keys[0]!);
        if (!value) return 0;
        const record = JSON.parse(value) as DesktopDeviceRecord;
        if (record.ownerId !== args[0] || record.id !== args[1] || record.revokedAt !== undefined) return 0;
        values.set(keys[0]!, JSON.stringify({ ...record, revokedAt: Number(args[2]) }));
        return 1;
      }
      throw new Error("Unexpected Redis script");
    },
  };
}

const record = (id: string, ownerId = "owner-alpha"): DesktopDeviceRecord => ({
  id,
  ownerId,
  displayName: "Office desktop",
  capabilities: ["system:discover", "workspace:list"],
  credential: {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: Buffer.alloc(12, 1).toString("base64url"),
    ciphertext: Buffer.alloc(32, 2).toString("base64url"),
    tag: Buffer.alloc(16, 3).toString("base64url"),
  },
  createdAt: 1_700_000_000_000,
});

test("Redis device registry creates, retrieves and lists only owner-scoped records", async () => {
  const store = new RedisDesktopDeviceRegistryStore({ client: memoryRedis() });
  await store.create(record("desktop-device-0001"));
  await store.create(record("desktop-device-0002"));
  await store.create(record("desktop-device-0001", "owner-beta"));

  assert.equal((await store.getOwned("owner-alpha", "desktop-device-0001"))?.displayName, "Office desktop");
  assert.equal(await store.getOwned("owner-beta", "desktop-device-0002"), null);
  assert.deepEqual((await store.listOwned("owner-alpha")).map((item) => item.id).sort(), [
    "desktop-device-0001",
    "desktop-device-0002",
  ]);
  assert.deepEqual((await store.listOwned("owner-beta")).map((item) => item.id), ["desktop-device-0001"]);
});

test("Redis device registry enforces atomic uniqueness and per-owner device limits", async () => {
  const store = new RedisDesktopDeviceRegistryStore({ client: memoryRedis(), maxDevicesPerOwner: 1 });
  await store.create(record("desktop-device-0001"));
  await assert.rejects(store.create(record("desktop-device-0001")), /already exists/);
  await assert.rejects(store.create(record("desktop-device-0002")), /limit reached/);
});

test("Redis device registry persists owner-scoped revocation and refuses repeat revocation", async () => {
  const store = new RedisDesktopDeviceRegistryStore({ client: memoryRedis() });
  await store.create(record("desktop-device-0001"));
  assert.equal(await store.revokeOwned("owner-beta", "desktop-device-0001", 1_700_000_000_100), false);
  assert.equal(await store.revokeOwned("owner-alpha", "desktop-device-0001", 1_700_000_000_100), true);
  assert.equal(await store.revokeOwned("owner-alpha", "desktop-device-0001", 1_700_000_000_200), false);
  assert.equal((await store.getOwned("owner-alpha", "desktop-device-0001"))?.revokedAt, 1_700_000_000_100);
});

test("Redis device registry validates owner, device IDs and record fields", async () => {
  const store = new RedisDesktopDeviceRegistryStore({ client: memoryRedis() });
  await assert.rejects(store.create(record("bad")), /device ID/);
  await assert.rejects(store.create({ ...record("desktop-device-0001"), displayName: " " }), /display name/);
  await assert.rejects(store.listOwned(" "), /owner ID/);
  await assert.rejects(store.revokeOwned("owner-alpha", "desktop-device-0001", -1), /timestamp/);
});
