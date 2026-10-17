import { mkdirSync } from "node:fs";
import path from "node:path";
import { createSofiaApi } from "./server.js";
import { FileRunRecordStore } from "./run-record-store.js";
import { createSofiaAgentDependencies } from "../models/factory.js";
import { createDiscordInteractionTransport } from "../integrations/messaging/discord-interaction-transport.js";
import { parseDiscordIdAllowlist } from "../integrations/messaging/discord-allowlist.js";
import { submitDiscordTask, waitForDiscordTask } from "../integrations/messaging/discord-durable-job.js";

const workspace = path.resolve(process.env.SOFIA_WORKSPACE ?? process.cwd());
const apiKey = process.env.SOFIA_API_KEY?.trim();
if (!apiKey) throw new Error("SOFIA_API_KEY is required.");
const scopes = (process.env.SOFIA_API_SCOPES ?? "agent:run,agent:read").split(",").map((s) => s.trim()).filter(Boolean);
mkdirSync(path.join(workspace, ".sofia", "api-runs"), { recursive: true, mode: 0o700 });
const deps = createSofiaAgentDependencies(workspace);

const discordPublicKey = process.env.DISCORD_PUBLIC_KEY?.trim();
const discordBotToken = process.env.DISCORD_BOT_TOKEN?.trim();
const rawDiscordUserIds = process.env.DISCORD_ALLOWED_USER_IDS;
const rawDiscordChannelIds = process.env.DISCORD_ALLOWED_CHANNEL_IDS;
const discordConfigured = Boolean(discordPublicKey || discordBotToken || rawDiscordUserIds?.trim() || rawDiscordChannelIds?.trim());
let discordTransport: ReturnType<typeof createDiscordInteractionTransport> | undefined;
const discordAbort = new AbortController();

if (discordConfigured) {
  if (!discordPublicKey || !discordBotToken) {
    throw new Error("Discord integration requires DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN, DISCORD_ALLOWED_USER_IDS, and DISCORD_ALLOWED_CHANNEL_IDS.");
  }
  // Both allowlists are mandatory. An omitted user allowlist must never mean
  // that every non-bot user in an allowed channel can execute agent tasks.
  const discordUserIds = parseDiscordIdAllowlist(rawDiscordUserIds, "DISCORD_ALLOWED_USER_IDS");
  const discordChannelIds = parseDiscordIdAllowlist(rawDiscordChannelIds, "DISCORD_ALLOWED_CHANNEL_IDS");
  discordTransport = createDiscordInteractionTransport({
    publicKeyHex: discordPublicKey,
    botToken: discordBotToken,
    commandName: process.env.DISCORD_COMMAND_NAME?.trim() || "run",
    additionalCommandNames: ["status", "cancel"],
    allowedUserIds: discordUserIds,
    allowedChannelIds: discordChannelIds,
    onError: (event, status) => console.error("Discord transport error:", event, status ?? ""),
  });
  await discordTransport.start(discordAbort.signal, async (message) => {
    try {
      deps.securityController?.assertRunning();
      if (!deps.jobRuntime) throw new Error("Durable job runtime is unavailable.");
      const principalId = "discord:" + message.author.id;
      const command = message.content.trim().split(/\\s+/, 1)[0] ?? "";
      const argument = message.content.trim().slice(command.length).trim();
      if (command === "/status" || command === "/cancel") {
        if (!/^([0-9a-f]{8}-[0-9a-f-]{27,})$/i.test(argument)) {
          await discordTransport?.sendMessage(
            message.channelId,
            "Provide a valid Sofia job ID using /" + command.slice(1) + " job_id:<job-id>.",
            undefined,
            message.id,
          );
          return;
        }
        const job = await deps.jobRuntime.get(argument);
        if (!job || job.ownerKeyId !== principalId) {
          await discordTransport?.sendMessage(message.channelId, "Job not found or not accessible to this Discord user.", undefined, message.id);
          return;
        }
        if (command === "/status") {
          await discordTransport?.sendMessage(
            message.channelId,
            "Sofia job status: " + job.status + "\\nJob ID: " + job.id,
            undefined,
            message.id,
          );
          return;
        }
        const cancelled = await deps.jobRuntime.cancel(job.id);
        await discordTransport?.sendMessage(
          message.channelId,
          cancelled ? "Cancellation requested for job " + job.id + "." : "Job " + job.id + " is already terminal or cannot be cancelled.",
          undefined,
          message.id,
        );
        return;
      }
      const prefix = "/run";
      const task = message.content.startsWith(prefix) ? message.content.slice(prefix.length).trim() : "";
      if (!task) {
        await discordTransport?.sendMessage(message.channelId, "Please provide a task using /run task:<description>.", undefined, message.id);
        return;
      }
      const handle = await submitDiscordTask(deps.jobRuntime, task, principalId, discordAbort.signal);
      // Acknowledge while the interaction token is valid; final delivery uses the bot API
      // so jobs longer than Discord's interaction-token lifetime still report completion.
      await discordTransport?.sendMessage(
        message.channelId,
        "Sofia accepted your task.\nJob ID: " + handle.id + "\nI will post the result when it finishes.",
        undefined,
        message.id,
      );
      void waitForDiscordTask(handle, { signal: discordAbort.signal }).then(async (result) => {
        const prefix = result.status === "completed" ? "Sofia completed the task." : "Sofia job " + result.status + ".";
        const response = prefix + "\nJob ID: " + result.id + "\n" + result.summary;
        const safeResponse = response.length > 1700 ? response.slice(0, 1690) + "… (truncated)" : response;
        await discordTransport?.sendMessage(message.channelId, safeResponse);
      }).catch(async () => {
        try {
          await discordTransport?.sendMessage(
            message.channelId,
            "Sofia could not report the final result for job " + handle.id + ". Check server logs for a redacted error.",
          );
        } catch {
          // Delivery may be unavailable during shutdown; durable job state remains persisted.
        }
      });
    } catch {
      await discordTransport?.sendMessage(message.channelId, "Sofia could not start or complete that task. Check the server logs for a redacted error.", undefined, message.id);
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
