import assert from "node:assert/strict";
import test from "node:test";
import { createMessagingAccessCheck, createSofiaMessagingHandler } from "./sofia-handler.js";
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

test("greeting is answered conversationally without starting an agent run", async () => {
  const h = harness();
  const handle = createSofiaMessagingHandler({ ...h, acceptPlainTextTasks: true });
  assert.match(String(await handle(inbound("สวัสดี Sofia"))), /วันนี้อยากคุย/);
  assert.equal(h.starts.length, 0);
});

test("plain text can be submitted as a task when enabled", async () => {
  const h = harness();
  const handle = createSofiaMessagingHandler({ ...h, acceptPlainTextTasks: true });
  const reply = await handle(inbound("Please explain this TypeScript error", { messageId: "message-2" }));
  assert.match(String(reply), /รับเรื่องแล้ว/);
  assert.deepEqual(h.starts.map((entry) => entry.task), ["Please explain this TypeScript error"]);
});

test("help explains natural chat and warns against sharing secrets", async () => {
  const h = harness();
  const handle = createSofiaMessagingHandler({ ...h, acceptPlainTextTasks: true });
  assert.match(String(await handle(inbound("/start"))), /คุยกับฉันได้เหมือนคุยกับคน/);
  assert.match(String(await handle(inbound("/help"))), /อย่าส่งรหัสผ่าน/);
  assert.equal(h.starts.length, 0);
});

test("recent conversation context is included in the next task", async () => {
  const h = harness();
  const handle = createSofiaMessagingHandler({ ...h, acceptPlainTextTasks: true });
  await handle(inbound("ช่วยดู error นี้", { messageId: "message-1" }));
  handle.recordAssistantReply("chat-1", "ฉันพบว่า error มาจาก TypeScript");
  await handle(inbound("แล้วควรแก้ยังไง", { messageId: "message-2" }));
  assert.equal(h.starts.length, 2);
  assert.match(h.starts[1]?.context ?? "", /User: ช่วยดู error นี้/);
  assert.match(h.starts[1]?.context ?? "", /Sofia: ฉันพบว่า error มาจาก TypeScript/);
});

test("sensitive-looking messages are not retained in session context", async () => {
  const h = harness();
  const handle = createSofiaMessagingHandler({ ...h, acceptPlainTextTasks: true });
  await handle(inbound("my api_key=supersecretvalue", { messageId: "message-1" }));
  await handle(inbound("please continue", { messageId: "message-2" }));
  assert.doesNotMatch(h.starts[1]?.context ?? "", /supersecretvalue/);
});

test("command prefix can be configured for a bot mention", async () => {
  const h = harness();
  const handle = createSofiaMessagingHandler({ ...h, commandPrefix: "/run@SofiaBot" });
  assert.match(String(await handle(inbound("/run@SofiaBot inspect logs"))), /รับเรื่องแล้ว/);
  assert.equal(await handle(inbound("/run inspect logs")), undefined);
});

test("denied user cannot start a run", async () => {
  const h = harness(false);
  const handle = createSofiaMessagingHandler({ ...h, acceptPlainTextTasks: true });
  assert.match(String(await handle(inbound("do work")), /ยังไม่ได้รับอนุญาต/);
  assert.equal(h.starts.length, 0);
});

test("empty and overlong tasks are rejected", async () => {
  const empty = harness();
  const handleEmpty = createSofiaMessagingHandler({ ...empty });
  assert.match(String(await handleEmpty(inbound("/run"))), /พิมพ์สิ่งที่อยากให้ช่วย/);

  const long = harness();
  const handleLong = createSofiaMessagingHandler({ ...long, maxTaskCharacters: 3 });
  assert.match(String(await handleLong(inbound("/run four"))), /ยาวเกินไป/);
  assert.equal(long.starts.length, 0);
});

test("duplicate provider message is not started twice", async () => {
  const h = harness();
  const handle = createSofiaMessagingHandler({ ...h });
  assert.match(String(await handle(inbound("/run do work"))), /รับเรื่องแล้ว/);
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
