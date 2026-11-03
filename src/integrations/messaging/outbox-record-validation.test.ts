import assert from "node:assert/strict";
import test from "node:test";
import { isValidMessagingOutboxRecord } from "./outbox-record-validation.js";

const id = "123e4567-e89b-42d3-a456-426614174000";
const validRecord = () => ({
  id,
  platform: "line",
  message: { conversationId: "conversation-1", text: "delivery result" },
  createdAt: 1_000,
});

test("outbox validation accepts legacy records and bounded retry metadata", () => {
  assert.equal(isValidMessagingOutboxRecord(validRecord(), id), true);
  assert.equal(isValidMessagingOutboxRecord({
    ...validRecord(),
    attemptCount: 8,
    lastAttemptAt: 2_000,
    nextAttemptAt: 3_000,
    lastErrorCode: "provider_unavailable",
    state: "dead_letter",
    attemptHistory: Array.from({ length: 8 }, (_, index) => ({
      at: 2_000 + index,
      outcome: "failed" as const,
      code: "provider_unavailable" as const,
    })),
  }, id), true);
});

test("outbox validation rejects malformed identity, message, and timestamps", () => {
  assert.equal(isValidMessagingOutboxRecord({ ...validRecord(), id: "other" }, id), false);
  assert.equal(isValidMessagingOutboxRecord({ ...validRecord(), platform: "../line" }, id), false);
  assert.equal(isValidMessagingOutboxRecord({
    ...validRecord(), message: { conversationId: " ", text: "hello" },
  }, id), false);
  assert.equal(isValidMessagingOutboxRecord({
    ...validRecord(), message: { conversationId: "c", text: " " },
  }, id), false);
  assert.equal(isValidMessagingOutboxRecord({ ...validRecord(), createdAt: -1 }, id), false);
  assert.equal(isValidMessagingOutboxRecord({ ...validRecord(), createdAt: Number.MAX_SAFE_INTEGER + 1 }, id), false);
});

test("outbox validation rejects unsafe retry state before scheduling", () => {
  assert.equal(isValidMessagingOutboxRecord({ ...validRecord(), attemptCount: -1 }, id), false);
  assert.equal(isValidMessagingOutboxRecord({ ...validRecord(), attemptCount: 9 }, id), false);
  assert.equal(isValidMessagingOutboxRecord({ ...validRecord(), nextAttemptAt: -1 }, id), false);
  assert.equal(isValidMessagingOutboxRecord({ ...validRecord(), lastAttemptAt: 1.5 }, id), false);
  assert.equal(isValidMessagingOutboxRecord({ ...validRecord(), lastErrorCode: "provider_secret" }, id), false);
  assert.equal(isValidMessagingOutboxRecord({ ...validRecord(), state: "sending" }, id), false);
  assert.equal(isValidMessagingOutboxRecord({
    ...validRecord(),
    attemptHistory: [{ at: 1_000, outcome: "failed", code: "provider_unavailable", providerError: "secret" }],
  }, id), false);
  assert.equal(isValidMessagingOutboxRecord({
    ...validRecord(), attemptHistory: Array.from({ length: 9 }, () => ({
      at: 1_000, outcome: "failed", code: "provider_unavailable",
    })),
  }, id), false);
});

test("outbox validation rejects oversized optional provider identifiers", () => {
  assert.equal(isValidMessagingOutboxRecord({
    ...validRecord(), message: { conversationId: "c", text: "ok", replyToMessageId: "x".repeat(257) },
  }, id), false);
  assert.equal(isValidMessagingOutboxRecord({
    ...validRecord(), message: { conversationId: "c", text: "ok", interactionId: "x".repeat(513) },
  }, id), false);
});
