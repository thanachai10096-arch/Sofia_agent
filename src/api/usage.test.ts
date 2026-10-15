import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageLimiter } from "./usage.js";

test("tool-call accounting does not increment run count", () => {
  const usage = new UsageLimiter(10, 2);
  usage.consume("key-a");
  assert.equal(usage.recordToolCalls("key-a"), true);
  assert.equal(usage.recordToolCalls("key-a"), true);
  assert.deepEqual(
    { runs: usage.get("key-a").runs, toolCalls: usage.get("key-a").toolCalls },
    { runs: 1, toolCalls: 2 },
  );
});

test("tool-call accounting rejects calls at the configured cap", () => {
  const usage = new UsageLimiter(10, 1);
  assert.equal(usage.recordToolCalls("key-a"), true);
  assert.equal(usage.recordToolCalls("key-a"), false);
  assert.equal(usage.get("key-a").toolCalls, 1);
});

test("tool-call accounting isolates keys and validates amounts", () => {
  const usage = new UsageLimiter(10, 5);
  assert.equal(usage.recordToolCalls("key-a", 2), true);
  assert.equal(usage.get("key-b").toolCalls, 0);
  assert.throws(() => usage.recordToolCalls("key-a", 0), /Invalid tool call usage amount/);
  assert.throws(() => usage.consume("key-a", -1), /Invalid tool call usage amount/);
});

test("run quota and tool quota remain independent", () => {
  const usage = new UsageLimiter(1, 2);
  usage.consume("key-a");
  assert.throws(() => usage.consume("key-a"), /API usage quota exceeded/);
  assert.equal(usage.recordToolCalls("key-a"), true);
  assert.equal(usage.recordToolCalls("key-a"), true);
  assert.equal(usage.recordToolCalls("key-a"), false);
});
