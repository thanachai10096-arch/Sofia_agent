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
