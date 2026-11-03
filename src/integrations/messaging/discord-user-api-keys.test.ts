import assert from "node:assert/strict";
import test from "node:test";
import { matchDiscordUserApiKeys, parseDiscordUserApiKeys } from "./discord-user-api-keys.js";

test("Discord API key mapping parses distinct keys for numeric user IDs", () => {
  const mapping = parseDiscordUserApiKeys(JSON.stringify({
    "123456789": "sofia_user_key_123456789_abcdefghijkl",
    "987654321": "sofia_user_key_987654321_abcdefghijkl",
  }));
  assert.equal(mapping.get("123456789"), "sofia_user_key_123456789_abcdefghijkl");
  assert.equal(matchDiscordUserApiKeys(mapping, ["123456789", "987654321"]), true);
});

test("Discord API key mapping rejects malformed, duplicate, and reused credentials", () => {
  assert.throws(() => parseDiscordUserApiKeys("not-json"), /valid JSON/);
  assert.throws(() => parseDiscordUserApiKeys("[]"), /JSON object/);
  assert.throws(() => parseDiscordUserApiKeys(JSON.stringify({ "123": "bad\nkey" })), /invalid user ID or API key/);
  assert.throws(() => parseDiscordUserApiKeys(JSON.stringify({
    "123": "sofia_user_key_123456789_abcdefghijkl",
    "456": "sofia_user_key_123456789_abcdefghijkl",
  })), /distinct API key/);
});

test("Discord API key mapping must match the complete allowlist exactly", () => {
  const mapping = parseDiscordUserApiKeys(JSON.stringify({
    "123": "sofia_user_key_123456789_abcdefghijkl",
    "456": "sofia_user_key_456789123_abcdefghijkl",
  }));
  assert.equal(matchDiscordUserApiKeys(mapping, ["123", "456"]), true);
  assert.equal(matchDiscordUserApiKeys(mapping, ["123"]), false);
  assert.equal(matchDiscordUserApiKeys(mapping, ["123", "456", "789"]), false);
  assert.equal(matchDiscordUserApiKeys(mapping, []), false);
});
