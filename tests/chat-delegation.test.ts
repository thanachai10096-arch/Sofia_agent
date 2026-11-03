import assert from "node:assert/strict";
import test from "node:test";
import {
  signChatDelegation,
  verifyChatDelegation,
  type ChatDelegationInput,
  type ChatDelegationReplayStore,
} from "../src/api/chat-delegation.js";

const secret = "test-only-chat-delegation-secret-with-more-than-32-bytes";
const now = 1_800_000_000_000;

function claims(overrides: Partial<ChatDelegationInput> = {}): ChatDelegationInput {
  return {
    platform: "telegram",
    tenantId: "tenant-a",
    userId: "user-100",
    conversationId: "chat-200",
    issuedAt: now,
    nonce: "abcdefghijklmnopqrstuv",
    ...overrides,
  };
}

function replayStore(): ChatDelegationReplayStore {
  const seen = new Set<string>();
  return {
    async claim(input) {
      const key = [input.tenantId, input.platform, input.nonce].join(":");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  };
}

test("signed chat delegation derives tenant-scoped owner identity", async () => {
  const input = claims();
  const result = await verifyChatDelegation(input, signChatDelegation(input, secret), {
    secret, replayStore: replayStore(), now,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.ownerId, "tenant:tenant-a:telegram:user-100");
});

test("chat delegation rejects a modified claim", async () => {
  const input = claims();
  const signature = signChatDelegation(input, secret);
  const result = await verifyChatDelegation({ ...input, userId: "attacker" }, signature, {
    secret, replayStore: replayStore(), now,
  });
  assert.deepEqual(result, { ok: false, reason: "invalid_signature" });
});

test("chat delegation rejects expired claims before claiming nonce", async () => {
  let claimsCount = 0;
  const store: ChatDelegationReplayStore = { async claim() { claimsCount += 1; return true; } };
  const input = claims({ issuedAt: now - 300_001 });
  const result = await verifyChatDelegation(input, signChatDelegation(input, secret), {
    secret, replayStore: store, now,
  });
  assert.deepEqual(result, { ok: false, reason: "expired" });
  assert.equal(claimsCount, 0);
});

test("chat delegation rejects replayed nonces", async () => {
  const input = claims();
  const signature = signChatDelegation(input, secret);
  const store = replayStore();
  const first = await verifyChatDelegation(input, signature, { secret, replayStore: store, now });
  const second = await verifyChatDelegation(input, signature, { secret, replayStore: store, now });
  assert.equal(first.ok, true);
  assert.deepEqual(second, { ok: false, reason: "replayed" });
});

test("chat delegation fails closed when replay storage is unavailable", async () => {
  const input = claims();
  const result = await verifyChatDelegation(input, signChatDelegation(input, secret), {
    secret,
    replayStore: { async claim() { throw new Error("storage unavailable"); } },
    now,
  });
  assert.deepEqual(result, { ok: false, reason: "replay_store_unavailable" });
});

test("chat delegation rejects malformed identities and weak secrets", async () => {
  assert.throws(() => signChatDelegation(claims({ userId: "bad user id" }), secret), /Invalid chat delegation claims/);
  assert.throws(() => signChatDelegation(claims(), "short"), /at least 32/);
  const input = claims();
  const result = await verifyChatDelegation(input, "not-a-signature", {
    secret, replayStore: replayStore(), now,
  });
  assert.deepEqual(result, { ok: false, reason: "invalid_claims" });
});
