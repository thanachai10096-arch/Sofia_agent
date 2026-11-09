import assert from "node:assert/strict";
import test from "node:test";
import { createDiscordApprovalBroker } from "./discord-approval-broker.js";
import type { ApprovalRequest } from "../../agent/approval.js";

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    runId: "run-1",
    principalId: "discord:111111",
    notificationChannelId: "222222",
    toolName: "skill.files.modify",
    input: { path: "src/app.ts", operation: "patch" },
    actionHash: "a".repeat(64),
    risk: "critical",
    ...overrides,
  };
}

test("Discord approval requires the same authenticated user, channel, and exact action hash", async () => {
  let prompt = "";
  const broker = createDiscordApprovalBroker({
    sendMessage: async (_channel, text) => { prompt = text; },
    timeoutMs: 5_000,
  });
  const pending = broker.handle(request());
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(prompt, /skill\.files\.modify/);
  assert.match(prompt, /\/approve 123e4567-e89b-42d3-a456-426614174000/);

  assert.equal(broker.respond({
    channelId: "222222",
    authorId: "333333",
    content: "/approve 123e4567-e89b-42d3-a456-426614174000 " + "a".repeat(64),
  }), "unauthorized");
  assert.equal(broker.respond({
    channelId: "999999",
    authorId: "111111",
    content: "/approve 123e4567-e89b-42d3-a456-426614174000 " + "a".repeat(64),
  }), "unauthorized");
  assert.equal(broker.respond({
    channelId: "222222",
    authorId: "111111",
    content: "/approve 123e4567-e89b-42d3-a456-426614174000 " + "b".repeat(64),
  }), "action_mismatch");

  assert.equal(broker.respond({
    channelId: "222222",
    authorId: "111111",
    content: "/approve 123e4567-e89b-42d3-a456-426614174000 " + "a".repeat(64),
  }), "approved");
  assert.equal(await pending, true);
  assert.equal(broker.respond({
    channelId: "222222",
    authorId: "111111",
    content: "/approve 123e4567-e89b-42d3-a456-426614174000 " + "a".repeat(64),
  }), "not_found");
  broker.close();
});

test("Discord approval denies on explicit denial, cancellation, and delivery failure", async () => {
  const broker = createDiscordApprovalBroker({
    sendMessage: async () => undefined,
    timeoutMs: 5_000,
  });
  const denied = broker.handle(request());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(broker.respond({
    channelId: "222222",
    authorId: "111111",
    content: "/deny 123e4567-e89b-42d3-a456-426614174000 " + "a".repeat(64),
  }), "denied");
  assert.equal(await denied, false);

  const controller = new AbortController();
  const cancelled = broker.handle(request({
    requestId: "223e4567-e89b-42d3-a456-426614174000",
    signal: controller.signal,
  }));
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal(await cancelled, false);

  const unavailable = createDiscordApprovalBroker({
    sendMessage: async () => { throw new Error("transport down"); },
    timeoutMs: 5_000,
  });
  assert.equal(await unavailable.handle(request()), false);
  broker.close();
  unavailable.close();
});

test("Discord approval broker shutdown denies every pending request", async () => {
  const broker = createDiscordApprovalBroker({ sendMessage: async () => undefined });
  const first = broker.handle(request({
    requestId: "323e4567-e89b-42d3-a456-426614174000",
  }));
  const second = broker.handle(request({
    requestId: "423e4567-e89b-42d3-a456-426614174000",
  }));
  await new Promise((resolve) => setImmediate(resolve));
  broker.close();
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.equal(broker.respond({
    channelId: "222222",
    authorId: "111111",
    content: "/approve 323e4567-e89b-42d3-a456-426614174000 " + "a".repeat(64),
  }), "not_found");
});


test("Discord approval rejects non-Discord or incomplete request identity", async () => {
  const broker = createDiscordApprovalBroker({ sendMessage: async () => undefined });
  assert.equal(await broker.handle(request({ principalId: "api-key-1" })), false);
  assert.equal(await broker.handle(request({ notificationChannelId: "telegram:123" })), false);
  assert.equal(await broker.handle(request({ actionHash: "not-a-hash" })), false);
  broker.close();
});

test("Discord approval cannot be accepted until the exact prompt is delivered", async () => {
  let releaseDelivery!: () => void;
  const delivery = new Promise<void>((resolve) => { releaseDelivery = resolve; });
  const broker = createDiscordApprovalBroker({
    sendMessage: async () => delivery,
    timeoutMs: 5_000,
  });
  const pending = broker.handle(request());
  await new Promise((resolve) => setImmediate(resolve));

  const reply = {
    channelId: "222222",
    authorId: "111111",
    content: "/approve 123e4567-e89b-42d3-a456-426614174000 " + "a".repeat(64),
  };
  assert.equal(broker.respond(reply), "not_ready");

  releaseDelivery();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(broker.respond(reply), "approved");
  assert.equal(await pending, true);
  broker.close();
});
