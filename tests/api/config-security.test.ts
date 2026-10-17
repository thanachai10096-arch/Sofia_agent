import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSofiaApi } from "../../src/api/server.js";
import { FileUsageStore, UsageLimiter } from "../../src/api/usage.js";
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


test("FileUsageStore preserves API quota counters across limiter restarts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sofia-usage-store-"));
  try {
    const keyId = "a".repeat(32);
    new UsageLimiter(1, 10, new FileUsageStore(directory)).consume(keyId, 2);
    const restarted = new UsageLimiter(1, 10, new FileUsageStore(directory));
    assert.deepEqual(restarted.get(keyId), {
      keyId, runs: 1, toolCalls: 2, startedAt: restarted.get(keyId).startedAt,
    });
    assert.throws(() => restarted.consume(keyId), /API usage quota exceeded/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("UsageLimiter fails closed if durable usage persistence fails", () => {
  const store = {
    loadAllSync() { return []; },
    saveSync() { throw new Error("storage unavailable"); },
  };
  const limiter = new UsageLimiter(10, 10, store);
  assert.throws(() => limiter.consume("b".repeat(32)), /storage unavailable/);
  assert.equal(limiter.get("b".repeat(32)).runs, 0);
});
