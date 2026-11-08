import assert from "node:assert/strict";
import test from "node:test";
import type { RedisEvalClient } from "../../src/integrations/messaging/redis-rate-limiter.js";
import {
  REDIS_DESKTOP_PRESENCE_REFRESH_SCRIPT,
  REDIS_DESKTOP_PRESENCE_RELEASE_SCRIPT,
  RedisDesktopCompanionPresenceStore,
} from "../../src/desktop/redis-companion-presence.js";

function memoryRedis(): RedisEvalClient {
  const values = new Map<string, string>();
  return {
    async eval(script, { keys, arguments: args }) {
      const key = keys[0]!;
      if (script.includes("redis.call('SET', KEYS[1], ARGV[1], 'EX'")) {
        values.set(key, args[0]!);
        return "OK";
      }
      if (script === REDIS_DESKTOP_PRESENCE_REFRESH_SCRIPT) {
        const raw = values.get(key);
        if (!raw) return 0;
        const presence = JSON.parse(raw) as Record<string, unknown>;
        if (presence.sessionId !== args[0]) return 0;
        presence.lastSeenAt = Number(args[1]);
        values.set(key, JSON.stringify(presence));
        return 1;
      }
      if (script === REDIS_DESKTOP_PRESENCE_RELEASE_SCRIPT) {
        const raw = values.get(key);
        if (!raw) return 0;
        const presence = JSON.parse(raw) as Record<string, unknown>;
        if (presence.sessionId !== args[0]) return 0;
        values.delete(key);
        return 1;
      }
      if (script === "return redis.call('GET', KEYS[1])") return values.get(key) ?? null;
      throw new Error("Unexpected Redis script");
    },
  };
}

const identity = { ownerId: "owner-alpha", deviceId: "desktop-device-0001" };

test("presence claim stores an owner/device-scoped connection with worker identity", async () => {
  const store = new RedisDesktopCompanionPresenceStore({ client: memoryRedis(), ttlSeconds: 30 });
  const claimed = await store.claim({ ...identity, sessionId: "session-old-0001", workerId: "cloud-worker-01", now: 1_000 });
  assert.equal(claimed.ownerId, identity.ownerId);
  assert.equal(claimed.deviceId, identity.deviceId);
  assert.equal(claimed.workerId, "cloud-worker-01");
  assert.equal((await store.get(identity.ownerId, identity.deviceId))?.sessionId, "session-old-0001");
});

test("stale connection cannot refresh or release a replacement session", async () => {
  const store = new RedisDesktopCompanionPresenceStore({ client: memoryRedis() });
  await store.claim({ ...identity, sessionId: "session-old-0001", workerId: "worker-0001", now: 1_000 });
  await store.claim({ ...identity, sessionId: "session-new-0002", workerId: "worker-0002", now: 2_000 });
  assert.equal(await store.refresh(identity.ownerId, identity.deviceId, "session-old-0001", 2_100), false);
  assert.equal(await store.release(identity.ownerId, identity.deviceId, "session-old-0001"), false);
  const current = await store.get(identity.ownerId, identity.deviceId);
  assert.equal(current?.sessionId, "session-new-0002");
  assert.equal(current?.workerId, "worker-0002");
  assert.equal(await store.refresh(identity.ownerId, identity.deviceId, "session-new-0002", 2_200), true);
  assert.equal((await store.get(identity.ownerId, identity.deviceId))?.lastSeenAt, 2_200);
  assert.equal(await store.release(identity.ownerId, identity.deviceId, "session-new-0002"), true);
  assert.equal(await store.get(identity.ownerId, identity.deviceId), null);
});

test("presence store validates identity, timestamps and TTL bounds", async () => {
  const client = memoryRedis();
  assert.throws(() => new RedisDesktopCompanionPresenceStore({ client, ttlSeconds: 5 }), /TTL/);
  const store = new RedisDesktopCompanionPresenceStore({ client });
  await assert.rejects(store.claim({ ...identity, sessionId: "short", workerId: "worker-0001" }), /session ID/);
  await assert.rejects(store.claim({ ...identity, sessionId: "session-0001", workerId: "worker-0001", now: -1 }), /timestamp/);
  await assert.rejects(store.get(" ", identity.deviceId), /owner ID/);
});
