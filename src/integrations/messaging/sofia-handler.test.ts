import assert from "node:assert/strict";
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
