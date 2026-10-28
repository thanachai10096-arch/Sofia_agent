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
  const starts: Array<{ task: string; context?: string; options?: { idempotencyKey?: string } }> = [];
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
      starts.push({ task: input.task, context: input.context, options });
      return { id: "run-123", status: "queued" };
    },
  };
  return { starts, claims, policyInputs, accessPolicy: policy, deduplicator, client };
}

test("only explicit run commands start Sofia work", async () => {
  const h = harness();
  const handle = createSofiaMessagingHandler({ ...h });
  assert.equal(await handle(inbound("hello Sofia")), undefined);
  assert.equal(await handle(inbound("/run build the project")), "Sofia accepted the task (run run-123, status: queued).");
  assert.deepEqual(h.starts.map((entry) => entry.task), ["build the project"]);
  assert.ok(h.starts[0]?.options?.idempotencyKey?.startsWith("chat_"));
});

test("natural-chat mode starts a run from ordinary text without /run", async () => {
  const h = harness();
  const handle = createSofiaMessagingHandler({ ...h, commandPrefix: false });
  assert.equal(await handle(inbound("Hi Sofia, help me plan a release")), "Sofia accepted the task (run run-123, status: queued).");
  assert.deepEqual(h.starts.map((entry) => entry.task), ["Hi Sofia, help me plan a release"]);
  assert.ok(h.starts[0]?.options?.idempotencyKey?.startsWith("chat_"));
});

test("conversation context is forwarded through the existing API run starter", async () => {
  const h = harness();
  const handle = createSofiaMessagingHandler({
    ...h,
    commandPrefix: false,
    conversationContext: () => "Earlier: user asked about release planning.\nassistant: We chose staged rollout.",
  });
  await handle(inbound("continue the plan"));
  assert.match(h.starts[0]?.context ?? "", /Earlier: user asked about release planning/);
  assert.match(h.starts[0]?.context ?? "", /continue the plan/);
});

test("natural-chat mode ignores slash commands but keeps /run available", async () => {
  const h = harness();
  const handle = createSofiaMessagingHandler({ ...h, commandPrefix: false });
  assert.equal(await handle(inbound("/help")), undefined);
  assert.equal(await handle(inbound("/run summarize this project")), "Sofia accepted the task (run run-123, status: queued).");
  assert.deepEqual(h.starts.map((entry) => entry.task), ["summarize this project"]);
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
