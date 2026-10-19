import assert from "node:assert/strict";
import test from "node:test";
import { createSofiaApi } from "../../src/api/server.js";
import { UsageLimiter } from "../../src/api/usage.js";
import type { AgentDependencies } from "../../src/agent/types.js";

test("API rejects invalid numeric settings instead of silently disabling safeguards", () => {
  const invalidConfigs = [
    { maxBodyBytes: 0 },
    { maxRunsPerKeyPerDay: Number.NaN },
    { maxToolCallsPerKeyPerDay: Number.POSITIVE_INFINITY },
    { requestTimeoutMs: -1 },
    { maxConcurrentRunsPerKey: Number.NaN },
    { runRetentionMs: -1 },
  ];
  for (const invalid of invalidConfigs) {
    assert.throws(
      () => createSofiaApi({} as AgentDependencies, { apiKeys: {}, ...invalid }),
      /Invalid Sofia API configuration/,
    );
  }
});

test("UsageLimiter rejects invalid limits and usage increments", () => {
  assert.throws(() => new UsageLimiter(Number.NaN, 100), /Invalid maxRunsPerKey/);
  assert.throws(() => new UsageLimiter(100, -1), /Invalid maxToolCallsPerKey/);
  const limiter = new UsageLimiter(100, 100);
  assert.throws(() => limiter.consume("key", Number.NaN), /Invalid tool call usage amount/);
  assert.throws(() => limiter.consume("key", -1), /Invalid tool call usage amount/);
});


test("UsageLimiter counts tool-call attempts without incrementing run count", () => {
  const limiter = new UsageLimiter(2, 2);
  limiter.consume("key");
  limiter.consumeToolCall("key");
  assert.deepEqual(limiter.get("key"), {
    keyId: "key",
    runs: 1,
    toolCalls: 1,
    startedAt: limiter.get("key").startedAt,
  });
  limiter.consumeToolCall("key");
  assert.throws(() => limiter.consumeToolCall("key"), /API usage quota exceeded/);
  assert.equal(limiter.get("key").runs, 1);
});

test("UsageLimiter does not expose mutable internal counters", () => {
  const limiter = new UsageLimiter(1, 2);
  limiter.consume("key");
  const exposed = limiter.get("key");
  exposed.runs = 0;
  exposed.toolCalls = 0;
  assert.equal(limiter.get("key").runs, 1);
  assert.equal(limiter.get("key").toolCalls, 0);
  assert.throws(() => limiter.consume("key"), /API usage quota exceeded/);
});
