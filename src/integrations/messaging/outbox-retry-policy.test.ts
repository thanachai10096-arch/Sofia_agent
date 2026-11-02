import assert from "node:assert/strict";
import test from "node:test";
import { calculateMessagingRetry, DEFAULT_MESSAGING_RETRY_POLICY } from "./outbox-retry-policy.js";

test("messaging retry policy uses exponential backoff and caps the delay", () => {
  const now = 1_000_000;
  assert.deepEqual(calculateMessagingRetry(0, now), {
    attemptCount: 1,
    nextAttemptAt: now + 30_000,
    deadLetter: false,
  });
  assert.equal(calculateMessagingRetry(1, now).nextAttemptAt, now + 60_000);
  assert.equal(calculateMessagingRetry(7, now).nextAttemptAt, now + 60 * 60_000);
});

test("messaging retry policy marks the configured final attempt for dead-letter review", () => {
  const decision = calculateMessagingRetry(
    DEFAULT_MESSAGING_RETRY_POLICY.maxAttempts - 1,
    2_000,
  );
  assert.equal(decision.attemptCount, DEFAULT_MESSAGING_RETRY_POLICY.maxAttempts);
  assert.equal(decision.deadLetter, true);
});

test("messaging retry policy rejects invalid inputs", () => {
  assert.throws(() => calculateMessagingRetry(-1, 1));
  assert.throws(() => calculateMessagingRetry(0, Number.NaN));
  assert.throws(() => calculateMessagingRetry(0, 1, {
    baseDelayMs: 60_000,
    maxDelayMs: 30_000,
    maxAttempts: 8,
  }));
});
