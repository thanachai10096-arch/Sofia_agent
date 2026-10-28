import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UsageLimiter } from "./usage.js";

test("records aggregate Brain usage without conflating it with API runs and tool calls", () => {
  const usage = new UsageLimiter(10, 100);
  usage.consume("key-a", 2);
  usage.recordBrainUsage("key-a", { modelCalls: 3, reservedOrUsedTokens: 480 });
  usage.recordBrainUsage("key-a", { modelCalls: 2, reservedOrUsedTokens: 120, providerInputTokens: 90, providerOutputTokens: 30, providerUsageCalls: 2 });

  assert.deepEqual(usage.get("key-a"), {
    keyId: "key-a",
    runs: 1,
    toolCalls: 2,
    startedAt: usage.get("key-a").startedAt,
    brainRuns: 2,
    brainModelCalls: 5,
    brainReservedOrUsedTokens: 600,
    providerInputTokens: 90,
    providerOutputTokens: 30,
    providerUsageCalls: 2,
  });
  assert.equal(usage.get("key-b").brainReservedOrUsedTokens, 0);
});

test("persists Brain usage counters across limiter restarts", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sofia-usage-test-"));
  const store = path.join(dir, "usage.json");
  try {
    const first = new UsageLimiter(10, 100, store);
    first.consume("key-a", 1);
    first.recordBrainUsage("key-a", { modelCalls: 4, reservedOrUsedTokens: 999, providerInputTokens: 200, providerOutputTokens: 50, providerUsageCalls: 4 });

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
  assert.throws(() => usage.recordBrainUsage("key-a", { modelCalls: 1, reservedOrUsedTokens: 1, providerInputTokens: -1, providerOutputTokens: 1, providerUsageCalls: 1 }));
  assert.equal(usage.get("key-a").brainRuns, 0);
});

test("rejects aggregate usage counter overflow without partially mutating the ledger", () => {
  const usage = new UsageLimiter(10, 100);
  usage.recordBrainUsage("key-a", { modelCalls: Number.MAX_SAFE_INTEGER, reservedOrUsedTokens: 0 });
  const beforeModelOverflow = usage.get("key-a");
  assert.throws(
    () => usage.recordBrainUsage("key-a", { modelCalls: 1, reservedOrUsedTokens: 0 }),
    /safe integer range/,
  );
  assert.deepEqual(usage.get("key-a"), beforeModelOverflow);

  const provider = new UsageLimiter(10, 100);
  provider.recordBrainUsage("key-a", {
    modelCalls: 1, reservedOrUsedTokens: 1,
    providerInputTokens: Number.MAX_SAFE_INTEGER, providerOutputTokens: 0, providerUsageCalls: 1,
  });
  const beforeProviderOverflow = provider.get("key-a");
  assert.throws(
    () => provider.recordBrainUsage("key-a", {
      modelCalls: 1, reservedOrUsedTokens: 1,
      providerInputTokens: 1, providerOutputTokens: 0, providerUsageCalls: 1,
    }),
    /safe integer range/,
  );
  assert.deepEqual(provider.get("key-a"), beforeProviderOverflow);
});

test("preserves legacy persisted usage records until Brain usage is recorded", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sofia-usage-legacy-"));
  const store = path.join(dir, "usage.json");
  try {
    writeFileSync(store, JSON.stringify([{ keyId: "legacy-key", runs: 2, toolCalls: 3, startedAt: Date.now() }]));
    const usage = new UsageLimiter(10, 100, store);
    // Reading a legacy record may expose zero-valued compatibility fields to callers,
    // but must not rewrite the stored record merely by loading or consuming API usage.
    assert.equal(usage.get("legacy-key").brainRuns, 0);
    usage.consume("legacy-key", 1);
    const persisted = JSON.parse(readFileSync(store, "utf8")) as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(persisted[0]!).sort(), ["keyId", "runs", "startedAt", "toolCalls"]);
    assert.equal(persisted[0]!.runs, 3);
    assert.equal(persisted[0]!.toolCalls, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

