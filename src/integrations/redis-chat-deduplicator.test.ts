import assert from "node:assert/strict";
import test from "node:test";
import {
  REDIS_CHAT_DEDUPE_CLAIM_SCRIPT,
  REDIS_CHAT_DEDUPE_RELEASE_SCRIPT,
  RedisChatMessageDeduplicator,
} from "./redis-chat-deduplicator.js";
import type { RedisEvalClient } from "./messaging/redis-rate-limiter.js";

function memoryRedis(): RedisEvalClient {
  const values = new Map<string, string>();
  return {
    async eval(script, options) {
      const key = options.keys[0] ?? "";
      if (script === REDIS_CHAT_DEDUPE_CLAIM_SCRIPT) {
        if (values.has(key)) return 0;
        values.set(key, options.arguments[0] ?? "");
        return 1;
      }
      if (script === REDIS_CHAT_DEDUPE_RELEASE_SCRIPT) {
        if (values.get(key) === options.arguments[0]) {
          values.delete(key);
          return 1;
        }
        return 0;
      }
      throw new Error("unexpected script");
    },
  };
}

test("Redis chat deduplicator atomically claims a hashed scope and rejects duplicates", async () => {
  const calls: Array<{ script: string; keys: string[]; arguments: string[] }> = [];
  const client: RedisEvalClient = {
    async eval(script, options) {
      calls.push({ script, keys: options.keys, arguments: options.arguments });
      return calls.length === 1 ? 1 : 0;
    },
  };
  const deduplicator = new RedisChatMessageDeduplicator({ client, keyPrefix: "sofia:test:dedupe", ttlMs: 5_000 });
  assert.equal(await deduplicator.claim("telegram|channel-secret|message-1"), true);
  assert.equal(await deduplicator.claim("telegram|channel-secret|message-1"), false);
  assert.equal(calls[0]?.script, REDIS_CHAT_DEDUPE_CLAIM_SCRIPT);
  assert.match(calls[0]?.keys[0] ?? "", /^sofia:test:dedupe:[a-f0-9]{64}$/);
  assert.ok(!calls[0]?.keys[0]?.includes("channel-secret"));
  assert.deepEqual(calls[0]?.arguments.slice(1), ["5000"]);
});

test("Redis chat deduplicator releases only claims owned by this instance", async () => {
  const redis = memoryRedis();
  const first = new RedisChatMessageDeduplicator({ client: redis });
  const second = new RedisChatMessageDeduplicator({ client: redis });
  assert.equal(await first.claim("discord|channel|message"), true);
  assert.equal(await second.claim("discord|channel|message"), false);
  await second.release("discord|channel|message");
  assert.equal(await second.claim("discord|channel|message"), false);
  await first.release("discord|channel|message");
  assert.equal(await second.claim("discord|channel|message"), true);
});

test("Redis chat deduplicator validates options and rejects invalid Redis results", async () => {
  assert.throws(() => new RedisChatMessageDeduplicator({ client: memoryRedis(), keyPrefix: "bad prefix" }));
  assert.throws(() => new RedisChatMessageDeduplicator({ client: memoryRedis(), ttlMs: 999 }));
  assert.throws(() => new RedisChatMessageDeduplicator({ client: memoryRedis(), maxLocalClaims: 0 }));
  const invalidClient: RedisEvalClient = { async eval() { return "unexpected"; } };
  const deduplicator = new RedisChatMessageDeduplicator({ client: invalidClient });
  await assert.rejects(() => deduplicator.claim("key"), /invalid chat deduplication result/i);
});

test("Redis chat deduplicator propagates store errors and fails closed when local claims are full", async () => {
  const broken: RedisEvalClient = { async eval() { throw new Error("redis offline"); } };
  const deduplicator = new RedisChatMessageDeduplicator({ client: broken });
  await assert.rejects(() => deduplicator.claim("key"), /redis offline/);

  let calls = 0;
  const client: RedisEvalClient = {
    async eval() { calls += 1; return 1; },
  };
  const bounded = new RedisChatMessageDeduplicator({ client, maxLocalClaims: 1 });
  assert.equal(await bounded.claim("one"), true);
  assert.equal(await bounded.claim("two"), false);
  assert.equal(calls, 1);
});
