import assert from "node:assert/strict";
import test from "node:test";
import {
  REDIS_DESKTOP_ENROLLMENT_CONSUME_SCRIPT,
  REDIS_DESKTOP_ENROLLMENT_CREATE_SCRIPT,
  RedisDesktopEnrollmentChallengeStore,
} from "../../src/desktop/redis-enrollment-challenge-store.js";
import type { RedisEvalClient } from "../../src/integrations/messaging/redis-rate-limiter.js";

class FakeRedis implements RedisEvalClient {
  readonly values = new Map<string, string>();
  async eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    const key = options.keys[0]!;
    if (script === REDIS_DESKTOP_ENROLLMENT_CREATE_SCRIPT) {
      if (this.values.has(key)) return null;
      this.values.set(key, options.arguments[0]!);
      return "OK";
    }
    if (script === REDIS_DESKTOP_ENROLLMENT_CONSUME_SCRIPT) {
      const value = this.values.get(key) ?? null;
      this.values.delete(key);
      return value;
    }
    throw new Error("Unexpected Redis script.");
  }
}

test("Redis enrollment challenges are hashed-key, single-use records", async () => {
  const client = new FakeRedis();
  const store = new RedisDesktopEnrollmentChallengeStore({ client });
  const hash = "a".repeat(64);
  const challenge = { ownerId: "owner-1", expiresAt: 1_700_000_000_000 };
  await store.create(hash, challenge, 300);
  await assert.rejects(store.create(hash, challenge, 300));
  assert.deepEqual(await store.consume(hash), challenge);
  assert.equal(await store.consume(hash), null);
});

test("Redis enrollment challenge validates token hashes and TTL", async () => {
  const store = new RedisDesktopEnrollmentChallengeStore({ client: new FakeRedis() });
  await assert.rejects(store.create("not-a-hash", { ownerId: "owner-1", expiresAt: 1 }, 300));
  await assert.rejects(store.create("b".repeat(64), { ownerId: "owner-1", expiresAt: 1 }, 0));
});
