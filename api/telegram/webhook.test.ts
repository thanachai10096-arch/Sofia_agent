import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import telegramWebhook from "./webhook.js";

type EnvSnapshot = Record<string, string | undefined>;
const names = [
  "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_TOKEN", "SOFIA_API_BASE_URL",
  "SOFIA_UPSTREAM_API_KEY", "SOFIA_API_KEY", "TELEGRAM_ALLOWED_USER_IDS", "TELEGRAM_ALLOWED_CHAT_IDS",
] as const;
const originalEnv: EnvSnapshot = Object.fromEntries(names.map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;

function restoreEnv(): void {
  for (const name of names) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  globalThis.fetch = originalFetch;
}

afterEach(restoreEnv);

function configure(): void {
  process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret-token";
  process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  process.env.SOFIA_API_BASE_URL = "https://sofia.example";
  process.env.SOFIA_UPSTREAM_API_KEY = "test-upstream-key";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "12345";
  process.env.TELEGRAM_ALLOWED_CHAT_IDS = "-100123";
}

async function invoke(input: {
  method?: string;
  secret?: string | string[];
  body?: unknown;
} = {}): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, string> }> {
  const req = new PassThrough() as PassThrough & {
    method: string;
    headers: Record<string, string | string[]>;
  };
  req.method = input.method ?? "POST";
  req.headers = input.secret ? { "x-telegram-bot-api-secret-token": input.secret } : {};
  const headers: Record<string, string> = {};
  let responseBody = "";
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
    end(value?: string) { responseBody = value ?? ""; },
  };
  const promise = telegramWebhook(req as never, res as never);
  if (input.body !== undefined) req.end(JSON.stringify(input.body));
  else req.end("{}");
  await promise;
  return { status: res.statusCode, body: JSON.parse(responseBody || "{}"), headers };
}

function sampleUpdate(overrides: Record<string, unknown> = {}) {
  return {
    update_id: 991,
    message: {
      message_id: 7,
      text: "Hello Sofia",
      chat: { id: -100123, type: "supergroup" },
      from: { id: 12345, is_bot: false },
    },
    ...overrides,
  };
}

describe("Vercel Telegram webhook", () => {
  it("rejects non-POST requests", async () => {
    configure();
    const result = await invoke({ method: "GET" });
    assert.equal(result.status, 405);
    assert.equal(result.headers.allow, "POST");
  });

  it("fails closed when the webhook secret is invalid", async () => {
    configure();
    const result = await invoke({ secret: "wrong", body: sampleUpdate() });
    assert.equal(result.status, 401);
    assert.equal(result.body.error, "invalid_telegram_webhook_secret");
  });

  it("rejects duplicate secret headers without throwing or calling Sofia", async () => {
    configure();
    let called = false;
    globalThis.fetch = (async () => { called = true; throw new Error("must not call"); }) as typeof fetch;
    const result = await invoke({ secret: ["test-secret-token", "attacker-value"], body: sampleUpdate() });
    assert.equal(result.status, 401);
    assert.equal(result.body.error, "invalid_telegram_webhook_secret");
    assert.equal(called, false);
  });

  it("rejects same-character-length non-ASCII secrets without throwing", async () => {
    configure();
    const result = await invoke({ secret: "tést-secret-token", body: sampleUpdate() });
    assert.equal(result.status, 401);
    assert.equal(result.body.error, "invalid_telegram_webhook_secret");
  });

  it("ignores users outside the explicit allowlist without calling Sofia", async () => {
    configure();
    let called = false;
    globalThis.fetch = (async () => { called = true; throw new Error("must not call"); }) as typeof fetch;
    const result = await invoke({ secret: "test-secret-token", body: sampleUpdate({
      message: {
        message_id: 7, text: "Hello Sofia",
        chat: { id: -100123, type: "supergroup" },
        from: { id: 98765, is_bot: false },
      },
    }) });
    assert.equal(result.status, 200);
    assert.equal(result.body.ignored, true);
    assert.equal(called, false);
  });

  it("does not fall back to the model-provider key when the upstream key is missing", async () => {
    configure();
    delete process.env.SOFIA_UPSTREAM_API_KEY;
    process.env.SOFIA_API_KEY = "model-provider-secret";
    let called = false;
    globalThis.fetch = (async () => { called = true; throw new Error("must not call"); }) as typeof fetch;
    const result = await invoke({ secret: "test-secret-token", body: sampleUpdate() });
    assert.equal(result.status, 503);
    assert.equal(result.body.error, "telegram_integration_not_configured");
    assert.equal(called, false);
  });

  it("asks Telegram to retry when the upstream Sofia API is temporarily unavailable", async () => {
    configure();
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 503 })) as typeof fetch;
    const result = await invoke({ secret: "test-secret-token", body: sampleUpdate() });
    assert.equal(result.status, 503);
    assert.equal(result.body.error, "sofia_api_temporarily_unavailable");
  });

  it("does not retry permanent upstream rejections", async () => {
    configure();
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })) as typeof fetch;
    const result = await invoke({ secret: "test-secret-token", body: sampleUpdate() });
    assert.equal(result.status, 200);
    assert.equal(result.body.accepted, false);
    assert.equal(result.body.error, "sofia_api_rejected_request");
  });

  it("asks Telegram to retry when a successful upstream response has no run ID", async () => {
    configure();
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: "queued" }), { status: 202 })) as typeof fetch;
    const result = await invoke({ secret: "test-secret-token", body: sampleUpdate() });
    assert.equal(result.status, 502);
    assert.equal(result.body.error, "sofia_api_invalid_response");
  });

  it("forwards an allowlisted message to the Sofia API with an idempotency key", async () => {
    configure();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input).includes("api.telegram.org")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "run-123", status: "queued" }), { status: 202 });
    }) as typeof fetch;

    const result = await invoke({ secret: "test-secret-token", body: sampleUpdate() });
    assert.equal(result.status, 200);
    assert.equal(result.body.accepted, true);
    assert.equal(result.body.jobId, "run-123");
    const apiCall = calls.find((call) => call.url === "https://sofia.example/v1/agent/runs");
    assert.ok(apiCall);
    assert.equal(apiCall.init?.method, "POST");
    assert.equal(new Headers(apiCall.init?.headers).get("authorization"), "Bearer test-upstream-key");
    assert.match(new Headers(apiCall.init?.headers).get("idempotency-key") ?? "", /^telegram_[a-f0-9]{64}$/);
    assert.equal(JSON.parse(String(apiCall.init?.body)).task, "Hello Sofia");
  });
});
