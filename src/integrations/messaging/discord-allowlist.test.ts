import assert from "node:assert/strict";
import test from "node:test";
import { parseDiscordIdAllowlist } from "./discord-allowlist.js";

test("parses and trims an explicit Discord ID allowlist", () => {
  assert.deepEqual(parseDiscordIdAllowlist(" 123,456 ", "DISCORD_ALLOWED_USER_IDS"), ["123", "456"]);
});

test("rejects an empty Discord allowlist", () => {
  assert.throws(
    () => parseDiscordIdAllowlist(" , ", "DISCORD_ALLOWED_USER_IDS"),
    /DISCORD_ALLOWED_USER_IDS must contain at least one Discord ID/,
  );
});

test("rejects malformed Discord IDs", () => {
  assert.throws(
    () => parseDiscordIdAllowlist("123,not-an-id", "DISCORD_ALLOWED_CHANNEL_IDS"),
    /DISCORD_ALLOWED_CHANNEL_IDS contains an invalid Discord ID/,
  );
});

test("rejects duplicate Discord IDs rather than silently normalizing configuration", () => {
  assert.throws(
    () => parseDiscordIdAllowlist("123, 123", "DISCORD_ALLOWED_USER_IDS"),
    /DISCORD_ALLOWED_USER_IDS contains duplicate Discord IDs/,
  );
});
