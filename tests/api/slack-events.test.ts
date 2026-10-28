import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import slackEvents from "../../api/slack/events.js";

function signed(body: Buffer, secret: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = "v0=" + createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`v0:${timestamp}:`), body])).digest("hex");
  return { "x-slack-signature": signature, "x-slack-request-timestamp": timestamp };
}
async function invoke(body: Buffer, headers: Record<string, string>) {
  const req = Object.assign(Readable.from([body]), { method: "POST", headers }) as unknown as IncomingMessage;
  const out: { statusCode: number; body: string } = { statusCode: 200, body: "" };
  let responseStatus = 200;
  const res = {
    get statusCode() { return responseStatus; },
    set statusCode(value: number) { responseStatus = value; },
    setHeader() {},
    end(value?: string) { out.statusCode = responseStatus; out.body = value ?? ""; },
  } as unknown as ServerResponse;
  await slackEvents(req, res);
  return { statusCode: out.statusCode, body: JSON.parse(out.body || "{}") as Record<string, unknown> };
}
async function withEnv(values: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prior = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(values)) { prior.set(k, process.env[k]); if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { await fn(); } finally { for (const [k, v] of prior) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test("Slack Events verifies raw body before returning URL challenge", async () => {
  await withEnv({ SLACK_SIGNING_SECRET: "test-secret" }, async () => {
    const body = Buffer.from(JSON.stringify({ type: "url_verification", challenge: "challenge-123" }));
    assert.deepEqual(await invoke(body, signed(body, "test-secret")), { statusCode: 200, body: { challenge: "challenge-123" } });
    assert.deepEqual(await invoke(body, { "x-slack-signature": "v0=invalid", "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)) }), { statusCode: 401, body: { error: "invalid_slack_signature" } });
  });
});

test("Slack Events denies unallowlisted senders without calling Sofia", async () => {
  await withEnv({ SLACK_SIGNING_SECRET: "test-secret", SLACK_ALLOWED_USER_IDS: "UALLOWED", SLACK_ALLOWED_CHANNEL_IDS: "CALLOWED", SOFIA_API_BASE_URL: "https://sofia.example", SOFIA_API_KEY: "test-key", SLACK_BOT_TOKEN: "xoxb-12345678901234567890" }, async () => {
    const original = globalThis.fetch; let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error("unexpected fetch"); }) as typeof fetch;
    try {
      const body = Buffer.from(JSON.stringify({ type: "event_callback", event_id: "EvDenied", event: { type: "message", user: "U_OTHER", channel: "CALLOWED", text: "hello", ts: "1790000000.000001" } }));
      assert.deepEqual(await invoke(body, signed(body, "test-secret")), { statusCode: 200, body: { ok: true } });
      assert.equal(calls, 0);
    } finally { globalThis.fetch = original; }
  });
});

test("Slack Events returns retryable error when Sofia does not confirm run creation", async () => {
  await withEnv({ SLACK_SIGNING_SECRET: "test-secret", SLACK_ALLOWED_USER_IDS: "UALLOWED", SLACK_ALLOWED_CHANNEL_IDS: "CALLOWED", SOFIA_API_BASE_URL: "https://sofia.example", SOFIA_API_KEY: "test-key", SLACK_BOT_TOKEN: "xoxb-12345678901234567890" }, async () => {
    const original = globalThis.fetch; const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(input), init }); return { ok: false, status: 503, async json() { return { error: "unavailable" }; } } as Response; }) as typeof fetch;
    try {
      const body = Buffer.from(JSON.stringify({ type: "event_callback", event_id: "EvRetry", event: { type: "message", user: "UALLOWED", channel: "CALLOWED", text: "run task", ts: "1790000000.000001" } }));
      const result = await invoke(body, signed(body, "test-secret"));
      assert.equal(result.statusCode, 503);
      assert.deepEqual(result.body, { error: "sofia_run_not_accepted" });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.url, "https://sofia.example/v1/agent/runs");
      assert.equal(new Headers(calls[0]?.init?.headers).get("idempotency-key")?.startsWith("slack_"), true);
    } finally { globalThis.fetch = original; }
  });
});


test("Slack Events acknowledges only after Sofia accepts a run and posts a thread receipt", async () => {
  await withEnv({ SLACK_SIGNING_SECRET: "test-secret", SLACK_ALLOWED_USER_IDS: "UALLOWED", SLACK_ALLOWED_CHANNEL_IDS: "CALLOWED", SOFIA_API_BASE_URL: "https://sofia.example", SOFIA_API_KEY: "test-key", SLACK_BOT_TOKEN: "xoxb-12345678901234567890" }, async () => {
    const original = globalThis.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input) === "https://sofia.example/v1/agent/runs") {
        return { ok: true, status: 202, async json() { return { id: "run-accepted-123", status: "queued" }; } } as Response;
      }
      return { ok: true, status: 200, async json() { return { ok: true, ts: "1790000001.000002" }; } } as Response;
    }) as typeof fetch;
    try {
      const body = Buffer.from(JSON.stringify({ type: "event_callback", event_id: "EvAccepted", event: { type: "message", user: "UALLOWED", channel: "CALLOWED", text: "  do the task  ", ts: "1790000000.000001" } }));
      const result = await invoke(body, signed(body, "test-secret"));
      assert.deepEqual(result, { statusCode: 200, body: { ok: true } });
      assert.equal(calls.length, 2);
      assert.equal(calls[0]?.url, "https://sofia.example/v1/agent/runs");
      assert.equal(calls[1]?.url, "https://slack.com/api/chat.postMessage");
      const runRequest = JSON.parse(String(calls[0]?.init?.body)) as { task: string; async: boolean };
      assert.deepEqual(runRequest, { task: "do the task", async: true, context: "Origin: Slack message event. Slack user ID: UALLOWED. Channel ID: CALLOWED." });
      const receipt = JSON.parse(String(calls[1]?.init?.body)) as { channel: string; thread_ts: string; text: string };
      assert.equal(receipt.channel, "CALLOWED");
      assert.equal(receipt.thread_ts, "1790000000.000001");
      assert.match(receipt.text, /run-accepted-123/);
      assert.match(receipt.text, /queued/);
      assert.equal(new Headers(calls[0]?.init?.headers).get("idempotency-key")?.startsWith("slack_"), true);
    } finally { globalThis.fetch = original; }
  });
});


test("Slack retry of the same event reuses the same Sofia idempotency key", async () => {
  await withEnv({ SLACK_SIGNING_SECRET: "test-secret", SLACK_ALLOWED_USER_IDS: "UALLOWED", SLACK_ALLOWED_CHANNEL_IDS: "CALLOWED", SOFIA_API_BASE_URL: "https://sofia.example", SOFIA_API_KEY: "test-key", SLACK_BOT_TOKEN: "xoxb-12345678901234567890" }, async () => {
    const original = globalThis.fetch;
    const keys: string[] = [];
    const acceptedByKey = new Map<string, string>();
    let acceptedRuns = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "https://sofia.example/v1/agent/runs") {
        const key = new Headers(init?.headers).get("idempotency-key");
        assert.ok(key);
        keys.push(key);
        // Model the API contract: one distinct accepted run per idempotency key.
        let id = acceptedByKey.get(key);
        const isNewRun = !id;
        if (!id) {
          id = "run-idempotent-" + (++acceptedRuns);
          acceptedByKey.set(key, id);
        }
        return { ok: true, status: isNewRun ? 202 : 200, async json() { return { id, status: "queued" }; } } as Response;
      }
      return { ok: true, status: 200, async json() { return { ok: true }; } } as Response;
    }) as typeof fetch;
    try {
      const body = Buffer.from(JSON.stringify({ type: "event_callback", event_id: "EvRetriedSameEvent", event: { type: "message", user: "UALLOWED", channel: "CALLOWED", text: "do one thing", ts: "1790000000.000001" } }));
      const headers = signed(body, "test-secret");
      assert.equal((await invoke(body, headers)).statusCode, 200);
      assert.equal((await invoke(body, headers)).statusCode, 200);
      assert.equal(keys.length, 2);
      assert.equal(keys[0], keys[1]);
      assert.equal(acceptedRuns, 1);
    } finally { globalThis.fetch = original; }
  });
});
