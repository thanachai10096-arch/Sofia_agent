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

test("command-only mode stays backwards compatible", async () => {
  const h = harness();
  const handle = createSofiaMessagingHandler({ ...h });
  assert.equal(await handle(inbound("hello Sofia")), undefined);
  assert.match(String(await handle(inbound("/run build the project"))), /Sofia received your task/);
  assert.deepEqual(h.starts.map((entry) => entry.task), ["build the project"]);
  assert.ok(h.starts[0]?.options?.idempotencyKey?.startsWith("chat_"));
});

test("plain text can be submitted as a task when enabled", async () => {
  const h = harness();
  const handle = createSofiaMessagingHandler({ ...h, acceptPlainTextTasks: true });
  const reply = await handle(inbound("Please explain this TypeScript error", { messageId: "message-2" }));
  assert.match(String(reply), /Sofia received your task/);
  assert.deepEqual(h.starts.map((entry) => entry.task), ["Please explain this TypeScript error"]);
});

test("help and start explain natural chat without starting a run", async () => {
  const h = harness();
  const handle = createSofiaMessagingHandler({ ...h, acceptPlainTextTasks: true });
  assert.match(String(await handle(inbound("/start"))), /Send a task as a normal message/);
  assert.match(String(await handle(inbound("/help"))), /\/run <task>/);
  assert.equal(h.starts.length, 0);
});

test("command prefix can be configured for a bot mention", async () => {
  const h = harness();
  const handle = createSofiaMessagingHandler({ ...h, commandPrefix: "/run@SofiaBot" });
  assert.match(String(await handle(inbound("/run@SofiaBot inspect logs"))), /Sofia received your task/);
  assert.equal(await handle(inbound("/run inspect logs")), undefined);
});

test("denied user cannot start a run", async () => {
  const h = harness(false);
  const handle = createSofiaMessagingHandler({ ...h, acceptPlainTextTasks: true });
  assert.equal(await handle(inbound("do work")), "Access denied.");
  assert.equal(h.starts.length, 0);
});

test("empty and overlong tasks are rejected by existing dispatcher", async () => {
  const empty = harness();
  const handleEmpty = createSofiaMessagingHandler({ ...empty });
  assert.match(String(await handleEmpty(inbound("/run"))), /Usage: \/run <task>/);

  const long = harness();
  const handleLong = createSofiaMessagingHandler({ ...long, maxTaskCharacters: 3 });
  assert.equal(await handleLong(inbound("/run four")), "That message is too long. Please shorten it and try again.");
  assert.equal(long.starts.length, 0);
});

test("duplicate provider message is not started twice", async () => {
  const h = harness();
  const handle = createSofiaMessagingHandler({ ...h });
  assert.match(String(await handle(inbound("/run do work"))), /Sofia received your task/);
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
