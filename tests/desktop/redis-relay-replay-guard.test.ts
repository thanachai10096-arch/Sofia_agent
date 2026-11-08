import assert from "node:assert/strict";
import test from "node:test";
import {
  REDIS_DESKTOP_REPLAY_GUARD_SCRIPT,
  RedisDesktopRelayReplayGuard,
} from "../../src/desktop/redis-relay-replay-guard.js";
import type { RedisEvalClient } from "../../src/integrations/messaging/redis-rate-limiter.js";

class FakeRedis implements RedisEvalClient {
  readonly keys = new Set<string>();
  async eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    assert.equal(script, REDIS_DESKTOP_REPLAY_GUARD_SCRIPT);
    assert.equal(options.arguments.length, 1);
    const key = options.keys[0]!;
    if (this.keys.has(key)) return null;
    this.keys.add(key);
    return "OK";
  }
}

test("Redis relay replay guard atomically accepts a nonce only once", async () => {
  const client = new FakeRedis();
  const guard = new RedisDesktopRelayReplayGuard({ client });
  const args = ["desktop-device-0001", "nonce-abcdefghijkl", 20_000, 10_000] as const;
  assert.equal(await guard.consume(...args), true);
  assert.equal(await guard.consume(...args), false);
});

test("Redis relay replay guard hashes device and nonce and rejects expired windows", async () => {
  const client = new FakeRedis();
  const guard = new RedisDesktopRelayReplayGuard({ client, keyPrefix: "test:relay" });
  assert.equal(await guard.consume("desktop-device-0001", "nonce-abcdefghijkl", 9_999, 10_000), false);
  assert.equal(client.keys.size, 0);
  assert.equal(await guard.consume("desktop-device-0001", "nonce-abcdefghijkl", 20_000, 10_000), true);
  const key = [...client.keys][0]!;
  assert.match(key, /^test:relay:[a-f0-9]{64}$/);
  assert.equal(key.includes("desktop-device-0001"), false);
});

test("Redis relay replay guard fails closed on Redis errors and invalid inputs", async () => {
  const broken: RedisEvalClient = { eval: async () => { throw new Error("redis unavailable"); } };
  const guard = new RedisDesktopRelayReplayGuard({ client: broken });
  await assert.rejects(guard.consume("desktop-device-0001", "nonce-abcdefghijkl", 20_000, 10_000));
  await assert.rejects(guard.consume("bad", "nonce-abcdefghijkl", 20_000, 10_000));
});
