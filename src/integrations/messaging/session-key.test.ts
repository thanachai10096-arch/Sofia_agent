import assert from "node:assert/strict";
import test from "node:test";
import { messagingSessionKey } from "./session-key.js";

const identity = {
  platform: "discord" as const,
  userId: "123456789012345678",
  channelId: "222222222222222222",
  conversationId: "222222222222222222",
};

test("messaging session keys isolate platform, user, and conversation", () => {
  const base = messagingSessionKey(identity);
  assert.notEqual(base, messagingSessionKey({ ...identity, platform: "telegram" }));
  assert.notEqual(base, messagingSessionKey({ ...identity, userId: "987654321098765432" }));
  assert.notEqual(base, messagingSessionKey({ ...identity, conversationId: "333333333333333333" }));
});

test("messaging session keys use unambiguous length-prefixed components", () => {
  const left = messagingSessionKey({
    platform: "discord",
    userId: "a|1",
    channelId: "channel",
    conversationId: "b",
  });
  const right = messagingSessionKey({
    platform: "discord",
    userId: "a",
    channelId: "channel",
    conversationId: "1|b",
  });
  assert.notEqual(left, right);
});

test("user-channel mode scopes context to the actual channel rather than a thread alias", () => {
  const first = messagingSessionKey(identity, "user-channel");
  const second = messagingSessionKey({ ...identity, conversationId: "thread-1" }, "user-channel");
  assert.equal(first, second);
  assert.notEqual(first, messagingSessionKey(identity));
});

test("messaging session keys reject missing or oversized identity components", () => {
  assert.throws(() => messagingSessionKey({ ...identity, userId: "" }), /invalid messaging identity/i);
  assert.throws(() => messagingSessionKey({ ...identity, conversationId: "x".repeat(513) }), /invalid messaging identity/i);
});
