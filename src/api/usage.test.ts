import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UsageLimiter } from "./usage.js";

test("records aggregate Brain usage without conflating it with API runs and tool calls", () => {
  const usage = new UsageLimiter(10, 100);
  usage.consume("key-a", 2);
  usage.recordBrainUsage("key-a", { modelCalls: 3, reservedOrUsedTokens: 480 });
  usage.recordBrainUsage("key-a", { modelCalls: 2, reservedOrUsedTokens: 120 });

  assert.deepEqual(usage.get("key-a"), {
    keyId: "key-a",
    runs: 1,
    toolCalls: 2,
    startedAt: usage.get("key-a").startedAt,
    brainRuns: 2,
    brainModelCalls: 5,
    brainReservedOrUsedTokens: 600,
  });
  assert.equal(usage.get("key-b").brainReservedOrUsedTokens, undefined);
});

test("persists Brain usage counters across limiter restarts", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sofia-usage-test-"));
  const store = path.join(dir, "usage.json");
  try {
    const first = new UsageLimiter(10, 100, store);
    first.consume("key-a", 1);
    first.recordBrainUsage("key-a", { modelCalls: 4, reservedOrUsedTokens: 999 });

    const restarted = new UsageLimiter(10, 100, store);
    assert.deepEqual(restarted.get("key-a"), first.get("key-a"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects invalid Brain usage counters without mutating the ledger", () => {
  const usage = new UsageLimiter(10, 100);
  assert.throws(() => usage.recordBrainUsage("key-a", { modelCalls: -1, reservedOrUsedTokens: 1 }));
  assert.throws(() => usage.recordBrainUsage("key-a", { modelCalls: 1, reservedOrUsedTokens: Number.MAX_SAFE_INTEGER + 1 }));
  assert.equal(usage.get("key-a").brainRuns, undefined);
});
