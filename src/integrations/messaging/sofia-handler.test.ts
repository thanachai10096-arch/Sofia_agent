import assert from "node:assert/strict";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import test from "node:test";
import {
  createMessagingAccessCheck,
  createSofiaMessagingHandler,
} from "./sofia-handler.js";
import type { ChatAccessPolicy, ChatMessageDeduplicator, ChatRunStarter } from "../chat-adapter.js";
import type { InboundMessage } from "./types.js";

const inbound = (text: string, overrides: Partial<InboundMessage> = {}): InboundMessage => ({
  platform: "telegram",
  messageId: "message-1",
  identity: { platform: "telegram", userId: "user-1", channelId: "chat-1", conversationId: "chat-1" },
  text,
  attachments: [],
  receivedAt: 1,
  ...overrides,
});

function harness(allowed = true) {
  const starts: Array<{ task: string; options?: { idempotencyKey?: string } }> = [];
  const claims = new Set<string>();
  const policyInputs: Array<{ platform: string; senderId: string; conversationId: string }> = [];
  const policy: ChatAccessPolicy = {
    isAllowed(input) { policyInputs.push(input); return allowed; },
  };
  const deduplicator: ChatMessageDeduplicator = {
    claim(key) { if (claims.has(key)) return false; claims.add(key); return true; },
    release(key) { claims.delete(key); },
  };
  const client: ChatRunStarter = {
    async start(input, _signal, options) {
      starts.push({ task: input.task, options });
      return { id: "run-123", status: "queued" };
    },
  };
  return { starts, claims, policyInputs, accessPolicy: policy, deduplicator, client };
}

test("only explicit run commands start Sofia work when chat-first mode is disabled", async () => {
  const h = harness();
  const handle = createSofiaMessagingHandler({ ...h });
  assert.equal(await handle(inbound("hello Sofia")), undefined);
  assert.equal(await handle(inbound("/run build the project")), "Sofia accepted the task (run run-123, status: queued).");
  assert.deepEqual(h.starts.map((entry) => entry.task), ["build the project"]);
  assert.ok(h.starts[0]?.options?.idempotencyKey?.startsWith("chat_"));
});

test("command prefix can be configured for a bot mention", async () => {
  const h = harness();
  const handle = createSofiaMessagingHandler({ ...h, commandPrefix: "/run@SofiaBot" });
  assert.equal(await handle(inbound("/run@SofiaBot inspect logs")), "Sofia accepted the task (run run-123, status: queued).");
  assert.equal(await handle(inbound("/run inspect logs")), undefined);
});

test("denied user cannot start a run", async () => {
  const h = harness(false);
  const handle = createSofiaMessagingHandler({ ...h });
  assert.equal(await handle(inbound("/run do work")), "Access denied.");
  assert.equal(h.starts.length, 0);
});

test("empty and overlong tasks are rejected by existing dispatcher", async () => {
  const empty = harness();
  const handleEmpty = createSofiaMessagingHandler({ ...empty });
  assert.equal(await handleEmpty(inbound("/run")), "Usage: /run <task>");
  const long = harness();
  const handleLong = createSofiaMessagingHandler({ ...long, maxTaskCharacters: 3 });
  assert.equal(await handleLong(inbound("/run four")), "Task is too long. Please shorten it.");
  assert.equal(long.starts.length, 0);
});

test("duplicate provider message is not started twice", async () => {
  const h = harness();
  const handle = createSofiaMessagingHandler({ ...h });
  assert.equal(await handle(inbound("/run do work")), "Sofia accepted the task (run run-123, status: queued).");
  assert.equal(await handle(inbound("/run do work")), undefined);
  assert.equal(h.starts.length, 1);
});

test("access check maps normalized gateway IDs to existing policy contract", async () => {
  let received: unknown;
  const policy: ChatAccessPolicy = {
    isAllowed(input) { received = input; return true; },
  };
  const check = createMessagingAccessCheck(policy);
  assert.equal(await check({ platform: "discord", userId: "u-2", channelId: "channel-4" }), true);
  assert.deepEqual(received, { platform: "discord", senderId: "u-2", conversationId: "channel-4" });
});

test("invalid command prefixes are rejected at configuration time", () => {
  const h = harness();
  assert.throws(() => createSofiaMessagingHandler({ ...h, commandPrefix: " " }), /commandPrefix/);
  assert.throws(() => createSofiaMessagingHandler({ ...h, commandPrefix: "/run\nadmin" }), /commandPrefix/);
});

test("chat-first mode dispatches ordinary text and leaves slash commands alone", async () => {
  const h = harness();
  const handle = createSofiaMessagingHandler({ ...h, allowPlainText: true });
  assert.equal(await handle(inbound("Can you help me plan this project?")), "Sofia accepted the task (run run-123, status: queued).");
  assert.equal(await handle(inbound("/status")), undefined);
  assert.deepEqual(h.starts.map((entry) => entry.task), ["Can you help me plan this project?"]);
});

test("chat-first mode still rejects unauthorized users before creating a run", async () => {
  const h = harness(false);
  const handle = createSofiaMessagingHandler({ ...h, allowPlainText: true });
  assert.equal(await handle(inbound("Please inspect my project")), "Access denied.");
  assert.equal(h.starts.length, 0);
});

test("chat-first sessions remain isolated by immutable user and conversation identity", async () => {
  const starts: Array<{ task: string; sessionId?: string }> = [];
  const client: ChatRunStarter = {
    async start(input) {
      starts.push({ task: input.task, sessionId: input.sessionId });
      return { id: "run-" + starts.length, status: "queued" };
    },
  };
  const claims = new Set<string>();
  const handle = createSofiaMessagingHandler({
    client,
    accessPolicy: { isAllowed: () => true },
    deduplicator: {
      claim(key) { if (claims.has(key)) return false; claims.add(key); return true; },
      release(key) { claims.delete(key); },
    },
    allowPlainText: true,
  });
  await handle(inbound("remember my project", {
    messageId: "m-1",
    identity: { platform: "telegram", userId: "user-1", channelId: "chat-1", conversationId: "chat-1" },
  }));
  await handle(inbound("remember my project", {
    messageId: "m-2",
    identity: { platform: "telegram", userId: "user-2", channelId: "chat-2", conversationId: "chat-2" },
  }));
  assert.equal(starts.length, 2);
  assert.ok(starts[0]?.sessionId);
  assert.ok(starts[1]?.sessionId);
  assert.notEqual(starts[0]?.sessionId, starts[1]?.sessionId);
});


test("continuous-work chat commands are signed and dispatched with verified user identity", async () => {
  const h = harness();
  let received: { signedTask: string; messagingContext: import("../chat-adapter.js").SignedMessagingContext } | undefined;
  h.client.continuousWorkAction = async (input) => {
    received = input;
    return { work: { id: "work-chat-1", status: "paused" } };
  };
  const secret = "test-messaging-context-secret-at-least-32-chars";
  const handle = createSofiaMessagingHandler({ ...h, messagingContextSecret: secret });
  assert.equal(
    await handle(inbound("/work create improve the project safely")),
    "Created continuous task work-chat-1 (paused). Use /work continue work-chat-1 to start it.",
  );
  assert.ok(received);
  const parsed = JSON.parse(received.signedTask) as { action: string; task: string };
  assert.deepEqual(parsed, { action: "create", task: "improve the project safely" });
  assert.equal(received.messagingContext.userId, "user-1");
  assert.equal(received.messagingContext.conversationId, "chat-1");
  assert.equal(received.messagingContext.taskHash, createHash("sha256").update(received.signedTask).digest("hex"));
  const { signature, ...unsigned } = received.messagingContext;
  const expected = createHmac("sha256", secret).update(JSON.stringify(unsigned)).digest();
  assert.equal(timingSafeEqual(Buffer.from(signature, "hex"), expected), true);
});

test("continuous-work chat commands fail closed when signed context is not configured", async () => {
  const h = harness();
  h.client.continuousWorkAction = async () => ({ work: [] });
  const handle = createSofiaMessagingHandler({ ...h });
  assert.equal(
    await handle(inbound("/work list")),
    "Continuous-work chat controls are not configured on this Sofia server.",
  );
});

test("continuous-work chat commands reject unauthorized users before dispatch", async () => {
  const h = harness(false);
  let calls = 0;
  h.client.continuousWorkAction = async () => {
    calls += 1;
    return { work: [] };
  };
  const handle = createSofiaMessagingHandler({
    ...h,
    messagingContextSecret: "test-messaging-context-secret-at-least-32-chars",
  });
  assert.equal(await handle(inbound("/work list")), "Access denied.");
  assert.equal(calls, 0);
  assert.equal(h.claims.size, 0);
});

test("continuous-work chat commands bind signed context to the sender and isolate replay keys", async () => {
  const h = harness();
  const contexts: Array<import("../chat-adapter.js").SignedMessagingContext> = [];
  h.client.continuousWorkAction = async ({ messagingContext }) => {
    contexts.push(messagingContext);
    return { work: [] };
  };
  const handle = createSofiaMessagingHandler({
    ...h,
    messagingContextSecret: "test-messaging-context-secret-at-least-32-chars",
  });
  await handle(inbound("/work list", {
    messageId: "message-user-1",
    identity: { platform: "telegram", userId: "user-1", channelId: "chat-1", conversationId: "chat-1" },
  }));
  await handle(inbound("/work list", {
    messageId: "message-user-2",
    identity: { platform: "telegram", userId: "user-2", channelId: "chat-2", conversationId: "chat-2" },
  }));
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0]?.userId, "user-1");
  assert.equal(contexts[1]?.userId, "user-2");
  assert.notEqual(contexts[0]?.signature, contexts[1]?.signature);
  assert.equal(h.claims.size, 2);
});
