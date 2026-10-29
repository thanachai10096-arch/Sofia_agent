import assert from "node:assert/strict";
import test from "node:test";
import { createDiscordGatewayMessagingRuntime } from "./discord-gateway-runtime.js";

const valid = {
  SOFIA_DISCORD_GATEWAY_ENABLED: "true",
  DISCORD_BOT_TOKEN: "BotToken_1234567890.abcdef-XYZ",
  DISCORD_ALLOWED_USER_IDS: "123456789012",
  DISCORD_ALLOWED_CHANNEL_IDS: "234567890123",
  SOFIA_API_KEY: "test-key",
  SOFIA_API_BASE_URL: "https://sofia.example.invalid",
};

test("Discord Gateway messaging runtime is disabled unless explicitly enabled", () => {
  const warnings: string[] = [];
  assert.equal(createDiscordGatewayMessagingRuntime({ ...valid, SOFIA_DISCORD_GATEWAY_ENABLED: "false" }, "/tmp/sofia-discord-test", (warning) => warnings.push(warning)), undefined);
  assert.deepEqual(warnings, []);
});

test("Discord Gateway runtime fails closed when configuration or allowlists are invalid", () => {
  const warnings: string[] = [];
  assert.equal(createDiscordGatewayMessagingRuntime({ SOFIA_DISCORD_GATEWAY_ENABLED: "true" }, "/tmp/sofia-discord-test", (warning) => warnings.push(warning)), undefined);
  assert.match(warnings[0] ?? "", /explicit user\/channel allowlists/);
  assert.equal(createDiscordGatewayMessagingRuntime({ ...valid, DISCORD_ALLOWED_USER_IDS: "123,bad" }, "/tmp/sofia-discord-test", (warning) => warnings.push(warning)), undefined);
  assert.match(warnings[1] ?? "", /invalid Discord ID/);
  assert.doesNotMatch(warnings.join(" "), /test-key|BotToken/);
});

test("complete Discord Gateway configuration creates a runtime without opening a socket", async () => {
  const warnings: string[] = [];
  const runtime = createDiscordGatewayMessagingRuntime(valid, "/tmp/sofia-discord-test", (warning) => warnings.push(warning));
  assert.ok(runtime);
  await runtime.stop();
  assert.deepEqual(warnings, []);
});
