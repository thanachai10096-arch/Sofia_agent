import assert from "node:assert/strict";
import test from "node:test";
import { SofiaApiError } from "../../sdk/client.js";
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

test("Telegram API credentials are unique and scoped to every allowed sender", () => {
  const allowed = parseTelegramUserAllowlist("123,456");
  const keys = parseTelegramUserApiKeys('{"123":"key-one","456":"key-two"}', allowed);
  assert.equal(keys.get("123"), "key-one");
  assert.equal(keys.get("456"), "key-two");
  assert.throws(() => parseTelegramUserApiKeys('{"123":"same","456":"same"}', allowed), /unique non-empty API key/);
  assert.throws(() => parseTelegramUserApiKeys('{"123":"key-one"}', allowed), /every allowed Telegram user ID/);
  assert.throws(() => parseTelegramUserApiKeys('{"123":"key-one","999":"key-two"}', allowed), /every allowed Telegram user ID/);
  assert.throws(
    () => parseTelegramUserApiKeys('{"123":"master-key","456":"key-two"}', allowed, new Set(["master-key"])),
    /not shared with another Sofia identity/,
  );
  assert.throws(() => parseTelegramUserApiKeys('not-json', allowed), /every allowed Telegram user ID/);
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

test("Telegram refuses a shared API key when multiple users are allowed", () => {
  const warnings: string[] = [];
  const runtime = createTelegramMessagingRuntime({
    SOFIA_MESSAGING_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
    TELEGRAM_ALLOWED_USER_IDS: "123,456",
    TELEGRAM_ALLOWED_CHAT_IDS: "123",
    SOFIA_API_KEY: "shared-key",
    SOFIA_API_BASE_URL: "https://sofia.example.invalid",
  }, "/tmp/sofia-test", (message) => warnings.push(message));
  assert.equal(runtime, undefined);
  assert.match(warnings[0] ?? "", /Per-user Telegram API keys are required/);
  assert.doesNotMatch(warnings.join(" "), /shared-key/);
});

test("Telegram accepts distinct per-user API keys without a shared fallback key", async () => {
  const warnings: string[] = [];
  const runtime = createTelegramMessagingRuntime({
    SOFIA_MESSAGING_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
    TELEGRAM_ALLOWED_USER_IDS: "123,456",
    TELEGRAM_ALLOWED_CHAT_IDS: "123",
    TELEGRAM_USER_API_KEYS_JSON: '{"123":"key-one","456":"key-two"}',
    SOFIA_API_BASE_URL: "https://sofia.example.invalid",
  }, "/tmp/sofia-test", (message) => warnings.push(message));
  assert.ok(runtime);
  await runtime.stop();
  assert.deepEqual(warnings, []);
});


test("Telegram run completion sends the real completed output to the originating chat", async () => {
  const sent: Array<{ conversationId: string; text: string }> = [];
  const warnings: string[] = [];
  const events: string[] = [];
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
    onEvent: (event) => events.push(event),
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.conversationId, "chat-456");
  assert.match(sent[0]?.text ?? "", /Sofia completed the task/);
  assert.match(sent[0]?.text ?? "", /สวัสดีจาก Sofia/);
  assert.deepEqual(warnings, []);
  assert.deepEqual(events, [
    "telegram_run_terminal run_id=run-123 status=completed",
    "telegram_run_result_delivered run_id=run-123",
  ]);
});

test("Telegram run completion reports failed runs without exposing internal error details", async () => {
  const sent: Array<{ conversationId: string; text: string }> = [];
  const events: string[] = [];
  await reportTelegramRunCompletion({
    runId: "run-789",
    conversationId: "chat-456",
    waitForRun: async (id) => ({ id, status: "failed", error: "provider_http_402_insufficient_credits" }),
    send: async (message) => {
      sent.push({ conversationId: message.conversationId, text: message.text });
      return true;
    },
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(events, [
    "telegram_run_terminal run_id=run-789 status=failed",
    "telegram_run_result_delivered run_id=run-789",
  ]);
  assert.match(sent[0]?.text ?? "", /task failed/i);
  assert.match(sent[0]?.text ?? "", /Reason: provider_http_402_insufficient_credits/);
  assert.doesNotMatch(sent[0]?.text ?? "", /Bearer secret-token/);
});


test("Telegram run completion classifies API polling failures without logging error messages", async () => {
  const sent: Array<{ conversationId: string; text: string }> = [];
  const warnings: string[] = [];
  const events: string[] = [];
  await reportTelegramRunCompletion({
    runId: "run-api-failure",
    conversationId: "chat-456",
    waitForRun: async () => { throw new Error("Timed out waiting for Sofia job after repeated transient API errors.", { cause: new SofiaApiError("sensitive response body must not be logged", 503) }); },
    send: async (message) => {
      sent.push({ conversationId: message.conversationId, text: message.text });
      return true;
    },
    onWarning: (event) => warnings.push(event),
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(warnings, ["telegram_run_wait_failed run_id=run-api-failure kind=api_http_503"]);
  assert.deepEqual(events, ["telegram_run_status_notice_delivered run_id=run-api-failure"]);
  assert.equal(sent.length, 1);
  assert.match(sent[0]?.text ?? "", /could not retrieve the final result/);
  assert.doesNotMatch(warnings.join(" "), /sensitive response body/);
});

test("Telegram run completion records timeout and failed delivery separately", async () => {
  const warnings: string[] = [];
  await reportTelegramRunCompletion({
    runId: "run-timeout",
    conversationId: "chat-456",
    waitForRun: async () => { throw new Error("Timed out waiting for Sofia job."); },
    send: async () => false,
    onWarning: (event) => warnings.push(event),
  });
  assert.deepEqual(warnings, [
    "telegram_run_wait_failed run_id=run-timeout kind=timeout",
    "telegram_completion_delivery_failed run_id=run-timeout",
  ]);
});

test("Telegram approval commands list only the sender API key's pending approvals", async () => {
  const { handleTelegramApprovalCommand } = await import("./telegram-runtime.js");
  let listed = 0;
  const reply = await handleTelegramApprovalCommand({
    listApprovals: async () => {
      listed += 1;
      return { approvals: [{
        id: "123e4567-e89b-12d3-a456-426614174000",
        runId: "run-1", toolName: "workspace.write", input: { path: "notes.txt" },
        actionHash: "a".repeat(64), risk: "high", status: "pending", expiresAt: 1_900_000_000_000,
      }] };
    },
    decideApproval: async () => ({}),
  }, "/approvals");
  assert.equal(listed, 1);
  assert.match(reply ?? "", /workspace.write/);
  assert.match(reply ?? "", /Action hash: a{64}/);
});

test("Telegram approve and reject require the exact approval ID and action hash", async () => {
  const { handleTelegramApprovalCommand } = await import("./telegram-runtime.js");
  const decisions: Array<{ id: string; hash: string; approved: boolean }> = [];
  const client = {
    listApprovals: async () => ({ approvals: [] }),
    decideApproval: async (id: string, hash: string, approved: boolean) => {
      decisions.push({ id, hash, approved });
      return {};
    },
  };
  const id = "123e4567-e89b-12d3-a456-426614174000";
  const hash = "b".repeat(64);
  assert.match(await handleTelegramApprovalCommand(client, "/approve") ?? "", /Usage/);
  assert.match(await handleTelegramApprovalCommand(client, "/approve " + id + " " + hash) ?? "", /อนุมัติแล้ว/);
  assert.match(await handleTelegramApprovalCommand(client, "/reject " + id + " " + hash) ?? "", /ปฏิเสธ/);
  assert.deepEqual(decisions, [
    { id, hash, approved: true },
    { id, hash, approved: false },
  ]);
});
