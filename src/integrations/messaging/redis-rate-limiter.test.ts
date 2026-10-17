import assert from "node:assert/strict";
import test from "node:test";
import {
  REDIS_MESSAGING_RATE_LIMIT_SCRIPT,
  RedisMessagingRateLimiter,
  type RedisEvalClient,
} from "./redis-rate-limiter.js";

test("Redis limiter uses an atomic script and hashes the caller scope", async () => {
  const calls: Array<{ script: string; options: { keys: string[]; arguments: string[] } }> = [];
  const client: RedisEvalClient = {
    async eval(script, options) { calls.push({ script, options }); return 1; },
  };
  const limiter = new RedisMessagingRateLimiter({ client, keyPrefix: "sofia:test:rate" });
  assert.equal(await limiter.consume({ key: "telegram|user-secret|channel", limit: 4, windowMs: 5_000, now: 10 }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.script, REDIS_MESSAGING_RATE_LIMIT_SCRIPT);
  assert.deepEqual(calls[0]?.options.arguments, ["5000", "4"]);
  assert.match(calls[0]?.options.keys[0] ?? "", /^sofia:test:rate:[a-f0-9]{64}$/);
  assert.ok(!calls[0]?.options.keys[0]?.includes("user-secret"));
});

test("Redis limiter returns false after the atomic counter exceeds the limit", async () => {
  const limiter = new RedisMessagingRateLimiter({
    client: { async eval() { return 0; } },
  });
  assert.equal(await limiter.consume({ key: "scope", limit: 1, windowMs: 1_000, now: 0 }), false);
});

test("Redis limiter rejects invalid configuration and unexpected Redis results", async () => {
  assert.throws(() => new RedisMessagingRateLimiter({ client: { async eval() { return 1; } }, keyPrefix: "bad prefix" }));
  const limiter = new RedisMessagingRateLimiter({ client: { async eval() { return "unexpected"; } } });
  await assert.rejects(() => limiter.consume({ key: "scope", limit: 1, windowMs: 1_000, now: 0 }), /invalid messaging rate-limit result/i);
  await assert.rejects(() => limiter.consume({ key: "scope", limit: 0, windowMs: 1_000, now: 0 }), /invalid messaging rate limit/i);
});

test("Redis errors propagate so the gateway can fail closed", async () => {
  const limiter = new RedisMessagingRateLimiter({
    client: { async eval() { throw new Error("redis offline"); } },
  });
  await assert.rejects(() => limiter.consume({ key: "scope", limit: 5, windowMs: 60_000, now: Date.now() }), /redis offline/);
});
