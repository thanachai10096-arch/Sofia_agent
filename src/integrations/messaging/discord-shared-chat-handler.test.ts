import assert from "node:assert/strict";
import test from "node:test";
import type { JobRuntime } from "../../brain/job-runtime.js";
import type { ChatMessageDeduplicator } from "../chat-adapter.js";
import type { VerifiedDiscordMessage } from "./discord.js";
import { createDiscordSharedChatHandler } from "./discord-shared-chat-handler.js";

function harness() {
  const submissions: Array<Record<string, unknown>> = [];
  const sent: Array<{ channelId: string; text: string; interactionId?: string }> = [];
  const delivered: string[] = [];
  const jobs = new Map<string, Record<string, unknown>>();
  let nextId = 0;
  const runtime = {
    async submit(input: Record<string, unknown>) {
      submissions.push(input);
      const id = "job-" + (++nextId);
      jobs.set(id, { id, status: "completed", result: { summary: "verified result" } });
      return { id, status: "queued" };
    },
    async get(id: string) { return jobs.get(id); },
    async list() { return []; },
    async markNotificationDelivered(id: string) { delivered.push(id); },
  } as unknown as JobRuntime;
  const claims = new Set<string>();
  const deduplicator: ChatMessageDeduplicator = {
    claim(key) { if (claims.has(key)) return false; claims.add(key); return true; },
    release(key) { claims.delete(key); },
  };
  const sender = {
    async sendMessage(channelId: string, text: string, _replyTo?: string, interactionId?: string) {
      sent.push({ channelId, text, ...(interactionId ? { interactionId } : {}) });
      return { messageId: "sent-" + sent.length };
    },
  };
  const controller = new AbortController();
  const create = () => createDiscordSharedChatHandler({
    runtime,
    sender,
    deduplicator,
    allowedUserIds: new Set(["user-1", "user-2"]),
    allowedChannelIds: new Set(["channel-1", "channel-2"]),
    signal: controller.signal,
    pollIntervalMs: 0,
  });
  return { submissions, sent, delivered, create };
}

function message(id: string, userId: string, channelId: string, content: string): VerifiedDiscordMessage {
  return {
    signatureVerified: true,
    id,
    channelId,
    author: { id: userId, username: userId, bot: false },
    content,
    createdAt: Date.now(),
    attachments: [],
  };
}

test("Discord run requests use the shared chat dispatcher and preserve session-scoped jobs", async () => {
  const h = harness();
  const handle = h.create();
  const reply = await handle(message("interaction-1", "user-1", "channel-1", "/run summarize the project"));
  assert.match(reply ?? "", /รับคำขอแล้วครับ กำลังเริ่มทำงาน/);
  assert.equal(h.submissions.length, 1);
  assert.equal(h.submissions[0]?.task, "summarize the project");
  assert.equal(h.submissions[0]?.ownerKeyId, "discord:user-1");
  assert.equal(h.submissions[0]?.notificationChannelId, "channel-1");
  assert.equal(h.submissions[0]?.sessionKey, "7:discord|6:user-1|9:channel-1");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(h.sent.some((item) => item.text.includes("verified result")));
  assert.deepEqual(h.delivered, ["job-1"]);
});

test("concurrent Discord users cannot cross principals, channels, or session memory", async () => {
  const h = harness();
  const handle = h.create();
  await Promise.all([
    handle(message("interaction-a", "user-1", "channel-1", "/run task A")),
    handle(message("interaction-b", "user-2", "channel-2", "/run task B")),
  ]);
  assert.equal(h.submissions.length, 2);
  assert.deepEqual(
    h.submissions.map((item) => [item.ownerKeyId, item.notificationChannelId, item.sessionKey]).sort(),
    [
      ["discord:user-1", "channel-1", "7:discord|6:user-1|9:channel-1"],
      ["discord:user-2", "channel-2", "7:discord|6:user-2|9:channel-2"],
    ].sort(),
  );
});

test("shared Discord handler accepts ordinary natural language and rechecks allowlists", async () => {
  const h = harness();
  const handle = h.create();
  const reply = await handle(message("interaction-3", "user-1", "channel-1", "Please inspect this error"));
  assert.match(reply ?? "", /รับคำขอแล้วครับ กำลังเริ่มทำงาน/);
  const denied = await handle(message("interaction-4", "outsider", "channel-1", "/run do something"));
  assert.equal(denied, "Access denied.");
  assert.equal(h.submissions.length, 1);
});
