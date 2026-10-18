import assert from "node:assert/strict";
import test from "node:test";
import {
  createTelegramMessagingRuntime,
  parseTelegramChatAllowlist,
  parseTelegramUserAllowlist,
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
