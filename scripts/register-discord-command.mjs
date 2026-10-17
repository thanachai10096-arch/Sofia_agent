#!/usr/bin/env node
/**
 * Register/update only Sofia's /run command in one Discord guild.
 * Required environment variables: DISCORD_APPLICATION_ID, DISCORD_GUILD_ID,
 * DISCORD_BOT_TOKEN. This deliberately uses the single-command endpoint (POST),
 * never the bulk-overwrite endpoint, so other guild commands are preserved.
 */
const applicationId = process.env.DISCORD_APPLICATION_ID?.trim() ?? "";
const guildId = process.env.DISCORD_GUILD_ID?.trim() ?? "";
const botToken = process.env.DISCORD_BOT_TOKEN?.trim() ?? "";

const snowflake = /^\d{17,20}$/;
if (!snowflake.test(applicationId)) {
  console.error("DISCORD_APPLICATION_ID must be a valid Discord application ID.");
  process.exit(2);
}
if (!snowflake.test(guildId)) {
  console.error("DISCORD_GUILD_ID must be a valid Discord server ID.");
  process.exit(2);
}
if (!botToken || /[\r\n]/.test(botToken)) {
  console.error("DISCORD_BOT_TOKEN is required.");
  process.exit(2);
}

const endpoint = `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`;
const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    authorization: `Bot ${botToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    name: "run",
    description: "Send a task to Sofia Agent",
    type: 1,
    options: [{
      name: "task",
      description: "Task for Sofia to execute",
      type: 3,
      required: true,
      max_length: 4000,
    }],
  }),
});

if (!response.ok) {
  // Do not print request headers or the bot token.
  const body = await response.text();
  console.error(`Discord command registration failed (HTTP ${response.status}).`);
  if (body) console.error(body.slice(0, 1000));
  process.exit(1);
}
const command = await response.json();
console.log(`Registered /run for guild ${guildId} (command ID: ${command.id}).`);
