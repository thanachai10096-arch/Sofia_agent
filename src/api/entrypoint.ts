import { mkdirSync } from "node:fs";
import path from "node:path";
import { SofiaAgent } from "../agent/core.js";
import { createSofiaApi } from "./server.js";
import { FileRunRecordStore } from "./run-record-store.js";
import { createSofiaAgentDependencies } from "../models/factory.js";
import { createDiscordInteractionTransport } from "../integrations/messaging/discord-interaction-transport.js";

const workspace = path.resolve(process.env.SOFIA_WORKSPACE ?? process.cwd());
const apiKey = process.env.SOFIA_API_KEY?.trim();
if (!apiKey) throw new Error("SOFIA_API_KEY is required.");
const scopes = (process.env.SOFIA_API_SCOPES ?? "agent:run,agent:read").split(",").map((s) => s.trim()).filter(Boolean);
mkdirSync(path.join(workspace, ".sofia", "api-runs"), { recursive: true, mode: 0o700 });
const deps = createSofiaAgentDependencies(workspace);
const agent = new SofiaAgent(deps);

const discordPublicKey = process.env.DISCORD_PUBLIC_KEY?.trim();
const discordBotToken = process.env.DISCORD_BOT_TOKEN?.trim();
const discordUserIds = (process.env.DISCORD_ALLOWED_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const discordChannelIds = (process.env.DISCORD_ALLOWED_CHANNEL_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const discordConfigured = Boolean(discordPublicKey || discordBotToken || discordUserIds.length || discordChannelIds.length);
let discordTransport: ReturnType<typeof createDiscordInteractionTransport> | undefined;
const discordAbort = new AbortController();

if (discordConfigured) {
  if (!discordPublicKey || !discordBotToken || discordChannelIds.length === 0) {
    throw new Error("Discord integration requires DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN, and DISCORD_ALLOWED_CHANNEL_IDS. DISCORD_ALLOWED_USER_IDS is optional; when omitted, all non-bot users in the allowed channels may use /run.");
  }
  discordTransport = createDiscordInteractionTransport({
    publicKeyHex: discordPublicKey,
    botToken: discordBotToken,
    commandName: process.env.DISCORD_COMMAND_NAME?.trim() || "run",
    ...(discordUserIds.length ? { allowedUserIds: discordUserIds } : {}),
    allowedChannelIds: discordChannelIds,
    onError: (event, status) => console.error("Discord transport error:", event, status ?? ""),
  });
  await discordTransport.start(discordAbort.signal, async (message) => {
    const prefix = "/run";
    const task = message.content.startsWith(prefix) ? message.content.slice(prefix.length).trim() : "";
    if (!task) {
      await discordTransport?.sendMessage(message.channelId, "Please provide a task using /run task:<description>.", undefined, message.id);
      return;
    }
    try {
      const result = await agent.run({
        principalId: "discord:" + message.author.id,
        task,
        signal: discordAbort.signal,
      });
      const response = JSON.stringify(result);
      const safeResponse = response.length > 1700 ? response.slice(0, 1690) + "… (truncated)" : response;
      await discordTransport?.sendMessage(message.channelId, safeResponse, undefined, message.id);
    } catch {
      await discordTransport?.sendMessage(message.channelId, "Sofia could not complete that task. Check the server logs for a redacted error.", undefined, message.id);
    }
  });
}

const server = createSofiaApi(deps, {
  apiKeys: { [apiKey]: scopes },
  allowedOrigins: (process.env.SOFIA_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  runStore: new FileRunRecordStore(path.join(workspace, ".sofia", "api-runs")),
  ...(discordTransport ? { discordInteractionRoute: { transport: discordTransport } } : {}),
});
const port = Number(process.env.PORT ?? 3000);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
server.listen(port, "0.0.0.0", () => console.log("Sofia Agent API listening on port " + port));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    discordAbort.abort();
    void discordTransport?.stop();
    server.close();
  });
}
