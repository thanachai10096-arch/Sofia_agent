import assert from "node:assert/strict";
import test from "node:test";
import { createDiscordAdapter, type DiscordTransport } from "./discord.js";

function createTransport(
  sendMessage: DiscordTransport["sendMessage"],
): DiscordTransport {
  return {
    async start() {},
    sendMessage,
    async stop() {},
  };
}

test("Discord adapter derives stable bounded nonces from durable delivery IDs", async () => {
  const calls: Array<{ channelId: string; text: string; nonce?: string }> = [];
  const adapter = createDiscordAdapter(createTransport(async (channelId, text, _reply, _interaction, nonce) => {
    calls.push({ channelId, text, ...(nonce ? { nonce } : {}) });
    return { messageId: `provider-${calls.length}` };
  }));

  const message = {
    conversationId: "channel-1",
    text: "durable notification",
    deliveryId: "outbox-uuid-1",
  };
  const first = await adapter.send(message);
  const firstNonce = calls[0]?.nonce;
  calls.length = 0;
  const second = await adapter.send(message);

  assert.equal(first.state, "sent");
  assert.equal(second.state, "sent");
  assert.equal(firstNonce, calls[0]?.nonce);
  assert.match(firstNonce ?? "", /^[a-f0-9]{25}$/);
  assert.equal(calls[0]?.channelId, "channel-1");
});

test("Discord adapter derives distinct stable nonces for each message chunk", async () => {
  const nonces: Array<string | undefined> = [];
  const adapter = createDiscordAdapter(createTransport(async (_channelId, _text, _reply, _interaction, nonce) => {
    nonces.push(nonce);
    return { messageId: `provider-${nonces.length}` };
  }));

  const result = await adapter.send({
    conversationId: "channel-1",
    text: "x".repeat(4_001),
    deliveryId: "outbox-uuid-2",
  });

  assert.equal(result.state, "sent");
  assert.equal(nonces.length, 3);
  assert.equal(new Set(nonces).size, 3);
  assert.ok(nonces.every((nonce) => typeof nonce === "string" && /^[a-f0-9]{25}$/.test(nonce)));
});

test("Discord adapter leaves nonce unset for ordinary messages without a delivery ID", async () => {
  let observedNonce: string | undefined = "unexpected";
  const adapter = createDiscordAdapter(createTransport(async (_channelId, _text, _reply, _interaction, nonce) => {
    observedNonce = nonce;
    return { messageId: "provider-1" };
  }));

  const result = await adapter.send({ conversationId: "channel-1", text: "ordinary reply" });
  assert.equal(result.state, "sent");
  assert.equal(observedNonce, undefined);
});
