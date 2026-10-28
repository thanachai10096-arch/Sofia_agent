import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import type { AgentRunInput, AgentRunResponse } from "../../api/types.js";
import { createSlackCompletionNotifier, type SlackCompletionEnvironment } from "./slack-completion.js";

const SECRET = "test-callback-secret-at-least-32-chars";
const TOKEN = "xoxb-12345678901234567890";
const USER = "UALLOWED";
const CHANNEL = "CALLOWED";
const THREAD = "1790000000.000001";
const TASK = "do the task";

function signedInput(task = TASK, user = USER, channel = CHANNEL): AgentRunInput {
  const digest = createHash("sha256").update(task).digest("hex");
  const signature = createHmac("sha256", SECRET).update(`${user}|${channel}|${THREAD}|${digest}`).digest("hex");
  return {
    task,
    async: true,
    context: `Origin: Slack message event. Slack user ID: ${user}. Channel ID: ${channel}. Message timestamp: ${THREAD}. Callback signature: ${signature}.`,
  };
}

function env(overrides: Partial<SlackCompletionEnvironment> = {}): SlackCompletionEnvironment {
  return {
    SOFIA_SLACK_CALLBACK_SECRET: SECRET,
    SLACK_ALLOWED_USER_IDS: USER,
    SLACK_ALLOWED_CHANNEL_IDS: CHANNEL,
    SLACK_BOT_TOKEN: TOKEN,
    ...overrides,
  };
}

function completed(output = "result"): AgentRunResponse {
  return { id: "run-test", status: "completed", result: { output } as AgentRunResponse["result"] };
}

test("Slack completion sends the redacted result to the signed allowlisted thread", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const notify = createSlackCompletionNotifier(env(), async (url, init) => {
    request = { url: String(url), init };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  await notify(completed("Task result. Authorization: Bearer xoxb-12345678901234567890"), signedInput());

  assert.equal(request?.url, "https://slack.com/api/chat.postMessage");
  assert.equal(request?.init?.method, "POST");
  const body = JSON.parse(String(request?.init?.body)) as { channel: string; thread_ts: string; text: string };
  assert.equal(body.channel, CHANNEL);
  assert.equal(body.thread_ts, THREAD);
  assert.match(body.text, /Task result/);
  assert.doesNotMatch(body.text, /xoxb-12345678901234567890/);
});

test("Slack completion rejects a signature reused with different task text", async () => {
  let calls = 0;
  const notify = createSlackCompletionNotifier(env(), async () => {
    calls++;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  await notify(completed(), { ...signedInput(), task: "different task" });
  assert.equal(calls, 0);
});

test("Slack completion requires both allowlists and valid server-side credentials", async () => {
  const invalidConfigs: Partial<SlackCompletionEnvironment>[] = [
    { SLACK_ALLOWED_USER_IDS: "" },
    { SLACK_ALLOWED_CHANNEL_IDS: "" },
    { SOFIA_SLACK_CALLBACK_SECRET: "too-short" },
    { SLACK_BOT_TOKEN: "" },
  ];
  for (const config of invalidConfigs) {
    let calls = 0;
    const notify = createSlackCompletionNotifier(env(config), async () => {
      calls++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    await notify(completed(), signedInput());
    assert.equal(calls, 0);
  }
});

test("Slack completion reports failed runs without forwarding an unbounded error", async () => {
  let message = "";
  const notify = createSlackCompletionNotifier(env(), async (_url, init) => {
    message = (JSON.parse(String(init?.body)) as { text: string }).text;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const error = "E".repeat(1_000);
  await notify({ id: "run-failed", status: "failed", error }, signedInput());
  assert.match(message, /Sofia task failed/);
  assert.ok(message.length < 400);
});
