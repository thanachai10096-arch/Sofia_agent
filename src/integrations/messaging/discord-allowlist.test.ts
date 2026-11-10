import assert from "node:assert/strict";
import test from "node:test";
import { isDiscordRecoveryDestinationAllowed, parseDiscordIdAllowlist } from "./discord-allowlist.js";

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

test("Discord recovery route requires the exact current user and channel allowlists", () => {
  const users = ["111111111111", "222222222222"];
  const channels = ["333333333333"];
  assert.equal(isDiscordRecoveryDestinationAllowed("discord:111111111111", "333333333333", users, channels), true);
  assert.equal(isDiscordRecoveryDestinationAllowed("discord:999999999999", "333333333333", users, channels), false);
  assert.equal(isDiscordRecoveryDestinationAllowed("discord:111111111111", "999999999999", users, channels), false);
  assert.equal(isDiscordRecoveryDestinationAllowed("discord:111111111111", undefined, users, channels), false);
  assert.equal(isDiscordRecoveryDestinationAllowed("discord:", "333333333333", users, channels), false);
  assert.equal(isDiscordRecoveryDestinationAllowed("api-key-owner", "333333333333", users, channels), false);
  assert.equal(isDiscordRecoveryDestinationAllowed("discord:111111111111", "333333333333", [], channels), false);
  assert.equal(isDiscordRecoveryDestinationAllowed("discord:111111111111", "333333333333", users, []), false);
});
