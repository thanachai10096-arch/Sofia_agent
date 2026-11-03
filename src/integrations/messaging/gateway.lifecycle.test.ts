import assert from "node:assert/strict";
import test from "node:test";
import { createMessagingGateway } from "./gateway.js";
import type { InboundMessage, MessagingAdapter } from "./types.js";

function message(): InboundMessage {
  return {
    platform: "telegram",
    messageId: "message-1",
    identity: {
      platform: "telegram",
      userId: "user-1",
      channelId: "chat-1",
      conversationId: "chat-1",
    },
    text: "hello",
    attachments: [],
    receivedAt: Date.now(),
  };
}

function adapter(): MessagingAdapter {
  return {
    platform: "telegram",
    async start() {},
    async stop() {},
    async send() { return { state: "sent" }; },
  };
}

test("a dispatch awaiting policy from an old generation is fenced after restart", async () => {
  let releasePolicy!: (allowed: boolean) => void;
  let policyStarted!: () => void;
  const policyPending = new Promise<boolean>((resolve) => { releasePolicy = resolve; });
  const policyEntered = new Promise<void>((resolve) => { policyStarted = resolve; });
  let handled = 0;

  const gateway = createMessagingGateway({
    enabled: true,
    adapters: [adapter()],
    allowUser: async () => {
      policyStarted();
      return policyPending;
    },
    onMessage: async () => {
      handled += 1;
      return "must not be delivered";
    },
  });

  await gateway.start();
  const dispatch = gateway.dispatch(message());
  await policyEntered;
  await gateway.restart();
  releasePolicy(true);

  assert.deepEqual(await dispatch, { status: "disabled" });
  assert.equal(handled, 0);
  assert.equal(gateway.getStatus(), "running");
  await gateway.stop();
});

test("a handler finishing after stop cannot send a stale reply", async () => {
  let finishHandler!: (reply: string) => void;
  let handlerStarted!: () => void;
  const handlerPending = new Promise<string>((resolve) => { finishHandler = resolve; });
  const entered = new Promise<void>((resolve) => { handlerStarted = resolve; });
  let sends = 0;

  const testAdapter: MessagingAdapter = {
    ...adapter(),
    async send() {
      sends += 1;
      return { state: "sent" };
    },
  };
  const gateway = createMessagingGateway({
    enabled: true,
    adapters: [testAdapter],
    allowUser: () => true,
    onMessage: async () => {
      handlerStarted();
      return handlerPending;
    },
  });

  await gateway.start();
  const dispatch = gateway.dispatch(message());
  await entered;
  await gateway.stop();
  finishHandler("stale reply");

  assert.deepEqual(await dispatch, { status: "disabled" });
  assert.equal(sends, 0);
});
