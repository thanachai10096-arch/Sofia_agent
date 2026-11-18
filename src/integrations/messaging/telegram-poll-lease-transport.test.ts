import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramHttpTransport } from "./telegram-http-transport.js";
import { createTelegramMessagingRuntime } from "./telegram-runtime.js";

const token = "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });

test("Telegram transport does not poll when distributed lease is unavailable", async () => {
  const calls: string[] = [];
  const events: string[] = [];
  const transport = createTelegramHttpTransport({
    token,
    pollLease: { async acquire() { return undefined; } },
    fetchImpl: async (input) => {
      calls.push(String(input));
      return ok(true);
    },
    onError(event) { events.push(event); },
  });
  await assert.rejects(() => transport.start(new AbortController().signal, async () => {}), /refusing to poll without ownership/);
  assert.deepEqual(calls, []);
  assert.deepEqual(events, ["poll_lease_unavailable"]);
  await transport.stop();
});

test("Telegram transport releases its distributed lease after polling stops", async () => {
  const events: string[] = [];
  let released = 0;
  let resolvePoll!: () => void;
  const pollStarted = new Promise<void>((resolve) => { resolvePoll = resolve; });
  const transport = createTelegramHttpTransport({
    token,
    pollLease: {
      async acquire() {
        return {
          async renew() { return true; },
          async release() { released++; },
        };
      },
    },
    fetchImpl: async (input, init) => {
      if (String(input).endsWith("/deleteWebhook")) return ok(true);
      if (String(input).endsWith("/getUpdates")) {
        resolvePoll();
        return await new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) { reject(new Error("aborted")); return; }
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return ok(true);
    },
    onError(event) { events.push(event); },
  });
  await transport.start(new AbortController().signal, async () => {});
  await pollStarted;
  await transport.stop();
  assert.equal(released, 1);
  assert.deepEqual(events, []);
});

test("Railway Telegram runtime fails closed without shared Redis lease credentials", () => {
  const warnings: string[] = [];
  const runtime = createTelegramMessagingRuntime({
    SOFIA_MESSAGING_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_ALLOWED_USER_IDS: "12345",
    TELEGRAM_ALLOWED_CHAT_IDS: "12345",
    SOFIA_API_KEY: "api-key",
    SOFIA_API_BASE_URL: "https://sofia.example.test",
    RAILWAY_ENVIRONMENT: "production",
  }, "/tmp/sofia-test", (message) => warnings.push(message));
  assert.equal(runtime, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /shared Redis poll lease is required/);
});

test("local Telegram runtime remains opt-in compatible when a lease is not required", () => {
  const warnings: string[] = [];
  const runtime = createTelegramMessagingRuntime({
    SOFIA_MESSAGING_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_ALLOWED_USER_IDS: "12345",
    TELEGRAM_ALLOWED_CHAT_IDS: "12345",
    SOFIA_API_KEY: "api-key",
    SOFIA_API_BASE_URL: "https://sofia.example.test",
  }, "/tmp/sofia-test", (message) => warnings.push(message));
  assert.ok(runtime);
  assert.deepEqual(warnings, []);
});

test("Telegram transport does not begin polling when stopped during webhook cleanup", async () => {
  let notifyWebhookStarted!: () => void;
  let finishWebhook!: (response: Response) => void;
  const webhookStarted = new Promise<void>((resolve) => { notifyWebhookStarted = resolve; });
  const webhookResponse = new Promise<Response>((resolve) => { finishWebhook = resolve; });
  const calls: string[] = [];
  let released = 0;
  const transport = createTelegramHttpTransport({
    token,
    pollLease: {
      async acquire() {
        return { async renew() { return true; }, async release() { released++; } };
      },
    },
    fetchImpl: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/deleteWebhook")) {
        notifyWebhookStarted();
        return webhookResponse;
      }
      return ok([]);
    },
  });
  const starting = transport.start(new AbortController().signal, async () => {});
  await webhookStarted;
  await transport.stop();
  finishWebhook(ok(true));
  await starting;
  assert.equal(calls.filter((url) => url.endsWith("/getUpdates")).length, 0);
  assert.equal(released, 1);
});
