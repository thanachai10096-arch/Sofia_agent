import assert from "node:assert/strict";
import test from "node:test";
import {
  createTelegramMessagingRuntime,
  reportTelegramRunCompletion,
  parseTelegramChatAllowlist,
  parseTelegramUserAllowlist,
  parseTelegramUserApiKeys,
} from "./telegram-runtime.js";

test("Telegram allowlists accept numeric user IDs and signed chat IDs", () => {
  assert.deepEqual([...parseTelegramUserAllowlist("123, 456")], ["123", "456"]);
  assert.deepEqual([...parseTelegramChatAllowlist("-100123, 456")], ["-100123", "456"]);
});

test("Telegram allowlists reject empty, malformed and duplicate IDs", () => {
  assert.throws(() => parseTelegramUserAllowlist(""), /valid numeric IDs/);
  assert.throws(() => parseTelegramUserAllowlist("123,abc"), /valid numeric IDs/);
  assert.throws(() => parseTelegramUserAllowlist("123,123"), /duplicate IDs/);
  assert.throws(() => parseTelegramChatAllowlist("-1, -1"), /duplicate IDs/);
});

test("Telegram per-user API key map requires an exact allowlist match and valid secrets", () => {
  const allowed = new Set(["123", "456"]);
  const parsed = parseTelegramUserApiKeys('{"123":"key-one","456":"key-two"}', allowed);
  assert.deepEqual([...parsed], [["123", "key-one"], ["456", "key-two"]]);
  assert.throws(() => parseTelegramUserApiKeys('{"123":"key-one"}', allowed), /exactly one API key/);
  assert.throws(() => parseTelegramUserApiKeys('{"123":"key-one","456":"key-two","789":"extra"}', allowed), /exactly one API key/);
  assert.throws(() => parseTelegramUserApiKeys('{"123":"","456":"key-two"}', allowed), /invalid user ID or API key/);
  assert.throws(() => parseTelegramUserApiKeys('{"123":"same-key","456":"same-key"}', allowed), /distinct API key/);
  assert.throws(() => parseTelegramUserApiKeys('{"123":"key-one\\nleak","456":"key-two"}', allowed), /invalid user ID or API key/);
  assert.throws(() => parseTelegramUserApiKeys("[]", allowed), /JSON object/);
  assert.throws(() => parseTelegramUserApiKeys("{", allowed), /JSON object/);
});

test("Telegram integration remains disabled unless explicitly enabled", () => {
  const warnings: string[] = [];
  const runtime = createTelegramMessagingRuntime({
    TELEGRAM_BOT_TOKEN: "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
    TELEGRAM_ALLOWED_USER_IDS: "123",
    TELEGRAM_ALLOWED_CHAT_IDS: "123",
    SOFIA_API_KEY: "test-key",
    SOFIA_API_BASE_URL: "https://sofia.example.invalid",
  }, "/tmp/sofia-test", (message) => warnings.push(message));
  assert.equal(runtime, undefined);
  assert.deepEqual(warnings, []);
});

test("incomplete Telegram configuration fails closed without stopping API startup", () => {
  const warnings: string[] = [];
  const runtime = createTelegramMessagingRuntime({
    SOFIA_MESSAGING_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "configured",
  }, "/tmp/sofia-test", (message) => warnings.push(message));
  assert.equal(runtime, undefined);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0]!, /configured/);
});

test("Telegram fails closed when multiple users would share one API-key memory owner", () => {
  const warnings: string[] = [];
  const runtime = createTelegramMessagingRuntime({
    SOFIA_MESSAGING_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
    TELEGRAM_ALLOWED_USER_IDS: "123,456",
    TELEGRAM_ALLOWED_CHAT_IDS: "123,-100456",
    SOFIA_API_KEY: "shared-test-key",
    SOFIA_API_BASE_URL: "https://sofia.example.invalid",
  }, "/tmp/sofia-test", (message) => warnings.push(message));
  assert.equal(runtime, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /TELEGRAM_USER_API_KEYS with a separate API key for every allowed user/);
  assert.doesNotMatch(warnings[0] ?? "", /shared-test-key/);
});

test("Telegram per-user API keys cannot reuse the core API identity", () => {
  const warnings: string[] = [];
  const runtime = createTelegramMessagingRuntime({
    SOFIA_MESSAGING_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
    TELEGRAM_ALLOWED_USER_IDS: "123",
    TELEGRAM_ALLOWED_CHAT_IDS: "123",
    SOFIA_API_KEY: "core-api-key",
    TELEGRAM_USER_API_KEYS: '{"123":"core-api-key"}',
    SOFIA_API_BASE_URL: "https://sofia.example.invalid",
  }, "/tmp/sofia-test", (message) => warnings.push(message));
  assert.equal(runtime, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /must not reuse SOFIA_API_KEY/);
  assert.doesNotMatch(warnings[0] ?? "", /core-api-key/);
});

test("Telegram runtime accepts multiple users only with a complete per-user API key map", async () => {
  const warnings: string[] = [];
  const runtime = createTelegramMessagingRuntime({
    SOFIA_MESSAGING_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
    TELEGRAM_ALLOWED_USER_IDS: "123,456",
    TELEGRAM_ALLOWED_CHAT_IDS: "123,-100456",
    TELEGRAM_USER_API_KEYS: '{"123":"user-one-key","456":"user-two-key"}',
    SOFIA_API_BASE_URL: "https://sofia.example.invalid",
  }, "/tmp/sofia-test", (message) => warnings.push(message));
  assert.ok(runtime);
  await runtime.stop();
  assert.deepEqual(warnings, []);
});

test("Telegram runtime rejects incomplete per-user API key maps without leaking secrets", () => {
  const warnings: string[] = [];
  const runtime = createTelegramMessagingRuntime({
    SOFIA_MESSAGING_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
    TELEGRAM_ALLOWED_USER_IDS: "123,456",
    TELEGRAM_ALLOWED_CHAT_IDS: "123,-100456",
    TELEGRAM_USER_API_KEYS: '{"123":"user-one-secret"}',
    SOFIA_API_BASE_URL: "https://sofia.example.invalid",
  }, "/tmp/sofia-test", (message) => warnings.push(message));
  assert.equal(runtime, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /exactly one API key for every allowed Telegram user ID/);
  assert.doesNotMatch(warnings[0] ?? "", /user-one-secret/);
});

test("complete Telegram configuration constructs a runtime without starting network polling", async () => {
  const warnings: string[] = [];
  const runtime = createTelegramMessagingRuntime({
    SOFIA_MESSAGING_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
    TELEGRAM_ALLOWED_USER_IDS: "123",
    TELEGRAM_ALLOWED_CHAT_IDS: "123",
    SOFIA_API_KEY: "test-key",
    SOFIA_API_BASE_URL: "https://sofia.example.invalid",
  }, "/tmp/sofia-test", (message) => warnings.push(message));
  assert.ok(runtime);
  await runtime.stop();
  assert.deepEqual(warnings, []);
});


test("Telegram run completion sends the real completed output to the originating chat", async () => {
  const sent: Array<{ conversationId: string; text: string }> = [];
  const warnings: string[] = [];
  await reportTelegramRunCompletion({
    runId: "run-123",
    conversationId: "chat-456",
    waitForRun: async (id, options) => {
      assert.equal(id, "run-123");
      assert.equal(options.timeoutMs, 30 * 60 * 1_000);
      assert.equal(options.intervalMs, 1_000);
      return { id, status: "completed", result: { output: "สวัสดีจาก Sofia" } };
    },
    send: async (message) => {
      sent.push({ conversationId: message.conversationId, text: message.text });
      return true;
    },
    onWarning: (event) => warnings.push(event),
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.conversationId, "chat-456");
  assert.match(sent[0]?.text ?? "", /Sofia completed the task/);
  assert.match(sent[0]?.text ?? "", /สวัสดีจาก Sofia/);
  assert.deepEqual(warnings, []);
});

test("Telegram run completion reports failed runs without exposing internal error details", async () => {
  const sent: Array<{ conversationId: string; text: string }> = [];
  await reportTelegramRunCompletion({
    runId: "run-789",
    conversationId: "chat-456",
    waitForRun: async (id) => ({ id, status: "failed", error: "provider_http_402_insufficient_credits" }),
    send: async (message) => {
      sent.push({ conversationId: message.conversationId, text: message.text });
      return true;
    },
  });
  assert.match(sent[0]?.text ?? "", /task failed/i);
  assert.match(sent[0]?.text ?? "", /Reason: provider_http_402_insufficient_credits/);
  assert.doesNotMatch(sent[0]?.text ?? "", /Bearer secret-token/);
});
