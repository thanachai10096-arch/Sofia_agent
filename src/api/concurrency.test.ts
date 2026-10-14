import assert from "node:assert/strict";
import test from "node:test";
import { KeyConcurrencyLimiter } from "./concurrency.js";

test("per-key concurrency limiter isolates keys and rejects work at the limit", () => {
  const limiter = new KeyConcurrencyLimiter();
  assert.equal(limiter.tryAcquire("a", 1), true);
  assert.equal(limiter.tryAcquire("a", 1), false);
  assert.equal(limiter.tryAcquire("b", 1), true);
  assert.equal(limiter.activeCount("a"), 1);
  limiter.release("a");
  assert.equal(limiter.activeCount("a"), 0);
  assert.equal(limiter.tryAcquire("a", 1), true);
});

test("a zero concurrency limit denies all work", () => {
  const limiter = new KeyConcurrencyLimiter();
  assert.equal(limiter.tryAcquire("a", 0), false);
  assert.equal(limiter.activeCount("a"), 0);
});
