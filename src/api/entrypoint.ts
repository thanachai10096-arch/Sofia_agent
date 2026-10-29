import { mkdirSync } from "node:fs";
import path from "node:path";
import { createSofiaApi } from "./server.js";
import { FileRunRecordStore } from "./run-record-store.js";
import { createSofiaAgentDependencies, createSofiaAgentDependenciesWithSessions } from "../models/factory.js";
import { createDiscordInteractionTransport } from "../integrations/messaging/discord-interaction-transport.js";
import { parseDiscordIdAllowlist } from "../integrations/messaging/discord-allowlist.js";
import { buildDiscordSessionContext, submitDiscordTask, waitForDiscordTask } from "../integrations/messaging/discord-durable-job.js";
import { messagingSessionKey } from "../integrations/messaging/session-key.js";
import { createTelegramMessagingRuntime } from "../integrations/messaging/telegram-runtime.js";
import { SofiaClient } from "../sdk/client.js";
import { redactSecrets } from "../security/guard.js";
import { FileChatMessageDeduplicator } from "../integrations/file-chat-deduplicator.js";
import { createDiscordAdapter } from "../integrations/messaging/discord.js";
import { createDiscordGatewayTransport } from "../integrations/messaging/discord-gateway-transport.js";
import { createMessagingGateway, type MessagingGateway } from "../integrations/messaging/gateway.js";
import { createMessagingAccessCheck, createSofiaMessagingHandler } from "../integrations/messaging/sofia-handler.js";

const processStartedAt = Date.now();
const workspace = path.resolve(process.env.SOFIA_WORKSPACE ?? process.cwd());
const apiKey = process.env.SOFIA_API_KEY?.trim();
if (!apiKey) throw new Error("SOFIA_API_KEY is required.");
const scopes = (process.env.SOFIA_API_SCOPES ?? "agent:run,agent:read").split(",").map((s) => s.trim()).filter(Boolean);
mkdirSync(path.join(workspace, ".sofia", "api-runs"), { recursive: true, mode: 0o700 });
const sessionDatabasePath = process.env.SOFIA_SESSION_DB_PATH?.trim();
const deps = sessionDatabasePath
  ? await createSofiaAgentDependenciesWithSessions(workspace, undefined, sessionDatabasePath)
  : createSofiaAgentDependencies(workspace);
// Telegram is an optional, explicitly enabled bridge into the existing Sofia API/Core.
const telegramRuntime = createTelegramMessagingRuntime(process.env, workspace);
let discordGateway: MessagingGateway | undefined;
let discordGatewayTransport: ReturnType<typeof createDiscordGatewayTransport> | undefined;

const discordPublicKey = process.env.DISCORD_PUBLIC_KEY?.trim();
const discordBotToken = process.env.DISCORD_BOT_TOKEN?.trim();
const rawDiscordUserIds = process.env.DISCORD_ALLOWED_USER_IDS;
const rawDiscordChannelIds = process.env.DISCORD_ALLOWED_CHANNEL_IDS;
const discordRequested = Boolean(discordPublicKey || discordBotToken || rawDiscordUserIds?.trim() || rawDiscordChannelIds?.trim());
// Keep the API available when optional Discord configuration is incomplete. Discord remains
// disabled unless every required credential and both explicit allowlists are configured.
const discordConfigured = Boolean(discordPublicKey && discordBotToken && rawDiscordUserIds?.trim() && rawDiscordChannelIds?.trim());
if (discordRequested && !discordConfigured) {
  console.error("Discord integration disabled: required configuration is incomplete; API will continue without Discord.");
}
let discordTransport: ReturnType<typeof createDiscordInteractionTransport> | undefined;
const discordAbort = new AbortController();
let discordRecoveryTimer: ReturnType<typeof setInterval> | undefined;

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
    additionalCommandNames: ["status", "cancel", "resume"],
    allowedUserIds: discordUserIds,
    allowedChannelIds: discordChannelIds,
    onError: (event, status) => console.error("Discord transport error:", event, status ?? ""),
  });
  await discordTransport.start(discordAbort.signal, async (message) => {
    try {
      deps.securityController?.assertRunning();
      if (!deps.jobRuntime) throw new Error("Durable job runtime is unavailable.");
      const principalId = "discord:" + message.author.id;
      const command = message.content.trim().split(/\s+/, 1)[0] ?? "";
      const argument = message.content.trim().slice(command.length).trim();
      if (command === "/status" || command === "/cancel" || command === "/resume") {
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
            "Sofia job status: " + job.status + "\nJob ID: " + job.id,
            undefined,
            message.id,
          );
          return;
        }
        if (command === "/resume") {
          if (!job.snapshot || job.status === "completed" || job.status === "cancelled" || job.status === "running") {
            await discordTransport?.sendMessage(
              message.channelId,
              "This job cannot be resumed. It must have a saved checkpoint and not be running, completed, or cancelled.",
              undefined,
              message.id,
            );
            return;
          }
          await discordTransport?.sendMessage(message.channelId, "Resume requested for job " + job.id + ".", undefined, message.id);
          void deps.jobRuntime.resume(job.id).then(async (resumed) => {
            const summary = resumed.result?.summary?.trim() || resumed.error?.trim() || "Sofia finished processing the resumed job.";
            const content = "Sofia resumed job " + resumed.status + ".\nJob ID: " + resumed.id + "\n" + summary;
            await discordTransport?.sendMessage(message.channelId, content.slice(0, 1700));
            await deps.jobRuntime?.markNotificationDelivered?.(resumed.id);
          }).catch(async () => {
            try {
              await discordTransport?.sendMessage(message.channelId, "Sofia could not resume job " + job.id + ". Check the job status and server logs.");
            } catch { /* durable state remains available for /status */ }
          });
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
      const sessionKey = messagingSessionKey({
        platform: "discord",
        userId: message.author.id,
        channelId: message.channelId,
        conversationId: message.channelId,
      });
      const sessionContext = await buildDiscordSessionContext(deps.jobRuntime, sessionKey);
      const taskWithMemory = sessionContext
        ? task + "\n\n" + sessionContext
        : task;
      const handle = await submitDiscordTask(deps.jobRuntime, taskWithMemory, principalId, discordAbort.signal, {
        channelId: message.channelId,
        sessionKey,
        sessionTask: task,
      });
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
        await deps.jobRuntime?.markNotificationDelivered?.(result.id);
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
    } catch (error) {
      // Log only the error class, never task text, credentials, interaction tokens, or raw provider messages.
      console.error("Discord command handler failed:", error instanceof Error ? error.name : "UnknownError");
      try {
        await discordTransport?.sendMessage(
          message.channelId,
          "Sofia could not start or complete that task. Check the server logs for a redacted error.",
          undefined,
          message.id,
        );
      } catch {
        console.error("Discord command error reply delivery failed.");
      }
    }
  });

  // Retry recovery notifications while the process is alive. A crashed worker may
  // still have an unexpired lease at startup; periodic list() calls let the runtime
  // mark it interrupted once that lease expires, then notify the user without a new restart.
  const notificationInFlight = new Set<string>();
  const notifyRecoveredJobs = async (): Promise<void> => {
    if (!deps.jobRuntime || !discordTransport || discordAbort.signal.aborted) return;
    const recoveredJobs = await deps.jobRuntime.list();
    for (const job of recoveredJobs) {
      if (!job.ownerKeyId?.startsWith("discord:") || !job.notificationChannelId ||
          job.notificationDelivered || job.status === "queued" || job.status === "running" ||
          Date.parse(job.createdAt) >= processStartedAt || notificationInFlight.has(job.id)) continue;
      notificationInFlight.add(job.id);
      try {
        const message = job.status === "completed"
          ? "Sofia has an undelivered completion notice for job " + job.id + ". Status: completed."
          : job.snapshot
            ? "Sofia recovered job " + job.id + ". Status: " + job.status + ". Use /resume job_id:" + job.id + " to continue from its checkpoint."
            : "Sofia recovered job " + job.id + ". Status: " + job.status + ". No resumable checkpoint is available.";
        await discordTransport.sendMessage(job.notificationChannelId, message);
        await deps.jobRuntime.markNotificationDelivered?.(job.id);
      } catch {
        // Keep the marker unset so the next retry can attempt delivery again.
      } finally {
        notificationInFlight.delete(job.id);
      }
    }
  };
  await notifyRecoveredJobs();
  discordRecoveryTimer = setInterval(() => {
    void notifyRecoveredJobs().catch(() => undefined);
  }, 5_000);
  discordRecoveryTimer.unref?.();
}

const server = createSofiaApi(deps, {
  apiKeys: { [apiKey]: scopes },
  allowedOrigins: (process.env.SOFIA_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  runStore: new FileRunRecordStore(path.join(workspace, ".sofia", "api-runs")),
  usageStorePath: path.join(workspace, ".sofia", "api-usage.json"),
  ...(discordTransport ? { discordInteractionRoute: { transport: discordTransport } } : {}),
});
const port = Number(process.env.PORT ?? 3000);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
server.listen(port, "0.0.0.0", () => {
  console.log("Sofia Agent API listening on port " + port);
  void telegramRuntime?.start().catch((error) => {
    console.error("Telegram integration failed to start:", error instanceof Error ? error.name : "UnknownError");
  });
  // Ordinary Discord messages are a separate, opt-in Gateway transport. Keep the
  // signed HTTP interactions route unchanged; both transports share Sofia Core/API.
  if (process.env.DISCORD_GATEWAY_ENABLED === "true") {
    const botToken = process.env.DISCORD_BOT_TOKEN?.trim();
    const rawUsers = process.env.DISCORD_ALLOWED_USER_IDS;
    const rawChannels = process.env.DISCORD_ALLOWED_CHANNEL_IDS;
    if (!botToken || !rawUsers?.trim() || !rawChannels?.trim()) {
      console.error("Discord Gateway disabled: bot token and explicit user/channel allowlists are required.");
      return;
    }
    try {
      const allowedUsers = parseDiscordIdAllowlist(rawUsers, "DISCORD_ALLOWED_USER_IDS");
      const allowedChannels = parseDiscordIdAllowlist(rawChannels, "DISCORD_ALLOWED_CHANNEL_IDS");
      const accessPolicy = {
        isAllowed(input: { platform: "telegram" | "discord" | "slack"; senderId: string; conversationId: string }) {
          return input.platform === "discord" &&
            allowedUsers.has(input.senderId) &&
            allowedChannels.has(input.conversationId);
        },
      };
      const baseUrl = process.env.SOFIA_API_BASE_URL?.trim() || "http://127.0.0.1:" + port;
      const client = new SofiaClient({ apiKey, baseUrl });
      const deduplicator = new FileChatMessageDeduplicator(path.join(workspace, ".sofia", "chat-dedupe"));
      discordGatewayTransport = createDiscordGatewayTransport({
        botToken,
        onError: (event, status) => console.error("Discord Gateway event:", event, status ?? ""),
      });
      const handler = createSofiaMessagingHandler({
        client,
        accessPolicy,
        deduplicator,
        commandPrefix: "/run",
        onAccepted: ({ runId, message }) => {
          void client.waitForRun(runId, { timeoutMs: 30 * 60 * 1_000, intervalMs: 1_000 })
            .then(async (run) => {
              const output = typeof run.result?.output === "string" ? run.result.output.trim() : "";
              const safeOutput = String(redactSecrets(output));
              const resultText = run.status === "completed"
                ? "Sofia completed the task.\nRun ID: " + runId + (safeOutput ? "\n\n" + safeOutput : "\n\nThe run completed without text output.")
                : "Sofia task " + run.status + ".\nRun ID: " + runId;
              await discordGateway?.send("discord", {
                conversationId: message.identity.conversationId,
                text: resultText,
              });
            })
            .catch(() => {
              void discordGateway?.send("discord", {
                conversationId: message.identity.conversationId,
                text: "Sofia could not retrieve the final result for run " + runId + ". Check the run status.",
              });
            });
        },
      });
      discordGateway = createMessagingGateway({
        enabled: true,
        adapters: [createDiscordAdapter(discordGatewayTransport)],
        allowUser: createMessagingAccessCheck(accessPolicy),
        onMessage: (message) => handler(message),
        logger: {
          info: (event) => console.log("Discord Gateway:", event),
          warn: (event) => console.error("Discord Gateway warning:", event),
        },
      });
      void discordGateway.start().catch((error) => {
        console.error("Discord Gateway failed to start:", error instanceof Error ? error.name : "UnknownError");
        discordGateway = undefined;
        discordGatewayTransport = undefined;
      });
    } catch (error) {
      console.error("Discord Gateway disabled:", error instanceof Error ? error.name : "configuration_error");
      discordGateway = undefined;
      discordGatewayTransport = undefined;
    }
  }
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    discordAbort.abort();
    if (typeof discordRecoveryTimer !== "undefined") clearInterval(discordRecoveryTimer);
    void discordTransport?.stop();
    void discordGateway?.stop().catch(() => console.error("Discord Gateway shutdown failed."));
    void telegramRuntime?.stop().catch(() => console.error("Telegram integration shutdown failed."));
    server.close(() => {
      if ("closeSessionStore" in deps && typeof deps.closeSessionStore === "function") deps.closeSessionStore();
    });
  });
}
