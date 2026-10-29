import { mkdirSync } from "node:fs";
import path from "node:path";
import { createSofiaApi } from "./server.js";
import { FileRunRecordStore } from "./run-record-store.js";
import { createSofiaAgentDependencies, createSofiaAgentDependenciesWithSessions } from "../models/factory.js";
import { createDiscordInteractionTransport } from "../integrations/messaging/discord-interaction-transport.js";
import { createDiscordGatewayTransport } from "../integrations/messaging/discord-gateway-transport.js";
import type { VerifiedDiscordMessage } from "../integrations/messaging/discord.js";
import { parseDiscordIdAllowlist } from "../integrations/messaging/discord-allowlist.js";
import { buildDiscordSessionContext, submitDiscordTask, waitForDiscordTask } from "../integrations/messaging/discord-durable-job.js";
import { messagingSessionKey } from "../integrations/messaging/session-key.js";
import { createTelegramMessagingRuntime } from "../integrations/messaging/telegram-runtime.js";
import { FileChatMessageDeduplicator } from "../integrations/file-chat-deduplicator.js";

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

const discordPublicKey = process.env.DISCORD_PUBLIC_KEY?.trim();
const discordBotToken = process.env.DISCORD_BOT_TOKEN?.trim();
const rawDiscordUserIds = process.env.DISCORD_ALLOWED_USER_IDS;
const rawDiscordChannelIds = process.env.DISCORD_ALLOWED_CHANNEL_IDS;
const discordGatewayRequested = process.env.DISCORD_GATEWAY_ENABLED === "true";
const discordInteractionConfigured = Boolean(discordPublicKey && discordBotToken && rawDiscordUserIds?.trim() && rawDiscordChannelIds?.trim());
const discordGatewayConfigured = Boolean(discordGatewayRequested && discordBotToken && rawDiscordUserIds?.trim() && rawDiscordChannelIds?.trim());
const discordRequested = Boolean(discordGatewayRequested || discordPublicKey || discordBotToken || rawDiscordUserIds?.trim() || rawDiscordChannelIds?.trim());
const discordConfigured = discordInteractionConfigured || discordGatewayConfigured;
if (discordRequested && !discordConfigured) {
  console.error("Discord integration disabled: required configuration is incomplete; API will continue without Discord.");
}
let discordTransport: ReturnType<typeof createDiscordInteractionTransport> | undefined;
let discordGatewayTransport: ReturnType<typeof createDiscordGatewayTransport> | undefined;
const discordAbort = new AbortController();
let discordRecoveryTimer: ReturnType<typeof setInterval> | undefined;

if (discordConfigured) {
  if (!discordBotToken || !rawDiscordUserIds?.trim() || !rawDiscordChannelIds?.trim()) {
    throw new Error("Discord integrations require DISCORD_BOT_TOKEN, DISCORD_ALLOWED_USER_IDS, and DISCORD_ALLOWED_CHANNEL_IDS.");
  }
  // Both allowlists are mandatory for every Discord transport. Missing user IDs must
  // never mean that every non-bot user in an allowed channel can execute tasks.
  const discordUserIds = parseDiscordIdAllowlist(rawDiscordUserIds, "DISCORD_ALLOWED_USER_IDS");
  const discordChannelIds = parseDiscordIdAllowlist(rawDiscordChannelIds, "DISCORD_ALLOWED_CHANNEL_IDS");
  const discordGatewayDeduplicator = new FileChatMessageDeduplicator(path.join(workspace, ".sofia", "chat-dedupe"));
  if (discordInteractionConfigured && discordPublicKey) {
    discordTransport = createDiscordInteractionTransport({
      publicKeyHex: discordPublicKey,
      botToken: discordBotToken,
      commandName: process.env.DISCORD_COMMAND_NAME?.trim() || "run",
      additionalCommandNames: ["status", "cancel", "resume"],
      allowedUserIds: discordUserIds,
      allowedChannelIds: discordChannelIds,
      onError: (event, status) => console.error("Discord transport error:", event, status ?? ""),
    });
  }
  if (discordGatewayConfigured) {
    try {
      discordGatewayTransport = createDiscordGatewayTransport({
        botToken: discordBotToken,
        onError: (event, status) => console.error("Discord Gateway error:", event, status ?? ""),
      });
    } catch (error) {
      console.error("Discord Gateway disabled:", error instanceof Error ? error.name : "UnknownError");
    }
  }
  const sendDiscordMessage = async (
    message: VerifiedDiscordMessage,
    channelId: string,
    text: string,
    replyToMessageId?: string,
    interactionId?: string,
  ) => {
    if (message.transportVerified === true) {
      return discordGatewayTransport?.sendMessage(channelId, text, replyToMessageId ?? message.id);
    }
    return discordTransport?.sendMessage(channelId, text, replyToMessageId, interactionId);
  };
  const handleDiscordMessage = async (message: VerifiedDiscordMessage) => {
    try {
      if (message.transportVerified === true &&
          (!discordUserIds.includes(message.author.id) || !discordChannelIds.includes(message.channelId))) return;
      const trimmedContent = message.content.trim();
      const command = trimmedContent.split(/\s+/, 1)[0] ?? "";
      const argument = trimmedContent.slice(command.length).trim();
      const prefix = "/run";
      const isRunCommand = trimmedContent === prefix || trimmedContent.startsWith(prefix + " ") || trimmedContent.startsWith(prefix + "\t");
      const isNaturalMessage = message.transportVerified === true &&
        (message.directMessage === true || message.addressedToBot === true) &&
        trimmedContent.length > 0 && !trimmedContent.startsWith("/");
      const isExplicitCommand = isRunCommand || command === "/status" || command === "/cancel" || command === "/resume";
      if (message.transportVerified === true && !isNaturalMessage && !isExplicitCommand) return;
      deps.securityController?.assertRunning();
      if (!deps.jobRuntime) throw new Error("Durable job runtime is unavailable.");
      if (message.transportVerified === true) {
        // Gateway events can be replayed across reconnects or process restarts.
        // Persist a claim only for a message that can dispatch work; fail closed if storage fails.
        const dedupeKey = "discord:gateway:" + message.channelId + ":" + message.id;
        if (!await discordGatewayDeduplicator.claim(dedupeKey)) return;
      }
      const principalId = "discord:" + message.author.id;
      if (command === "/status" || command === "/cancel" || command === "/resume") {
        if (!/^([0-9a-f]{8}-[0-9a-f-]{27,})$/i.test(argument)) {
          await sendDiscordMessage(message, 
            message.channelId,
            "Provide a valid Sofia job ID using /" + command.slice(1) + " job_id:<job-id>.",
            undefined,
            message.id,
          );
          return;
        }
        const job = await deps.jobRuntime.get(argument);
        if (!job || job.ownerKeyId !== principalId) {
          await sendDiscordMessage(message, message.channelId, "Job not found or not accessible to this Discord user.", undefined, message.id);
          return;
        }
        if (command === "/status") {
          await sendDiscordMessage(message, 
            message.channelId,
            "Sofia job status: " + job.status + "\nJob ID: " + job.id,
            undefined,
            message.id,
          );
          return;
        }
        if (command === "/resume") {
          if (!job.snapshot || job.status === "completed" || job.status === "cancelled" || job.status === "running") {
            await sendDiscordMessage(message, 
              message.channelId,
              "This job cannot be resumed. It must have a saved checkpoint and not be running, completed, or cancelled.",
              undefined,
              message.id,
            );
            return;
          }
          await sendDiscordMessage(message, message.channelId, "Resume requested for job " + job.id + ".", undefined, message.id);
          void deps.jobRuntime.resume(job.id).then(async (resumed) => {
            const summary = resumed.result?.summary?.trim() || resumed.error?.trim() || "Sofia finished processing the resumed job.";
            const content = "Sofia resumed job " + resumed.status + ".\nJob ID: " + resumed.id + "\n" + summary;
            await sendDiscordMessage(message, message.channelId, content.slice(0, 1700));
            await deps.jobRuntime?.markNotificationDelivered?.(resumed.id);
          }).catch(async () => {
            try {
              await sendDiscordMessage(message, message.channelId, "Sofia could not resume job " + job.id + ". Check the job status and server logs.");
            } catch { /* durable state remains available for /status */ }
          });
          return;
        }
        const cancelled = await deps.jobRuntime.cancel(job.id);
        await sendDiscordMessage(message, 
          message.channelId,
          cancelled ? "Cancellation requested for job " + job.id + "." : "Job " + job.id + " is already terminal or cannot be cancelled.",
          undefined,
          message.id,
        );
        return;
      }
      const task = isNaturalMessage
        ? trimmedContent
        : isRunCommand
          ? trimmedContent.slice(prefix.length).trim()
          : "";
      if (!task) {
        // Ignore ordinary group chatter instead of replying to every message.
        if (message.transportVerified === true && !trimmedContent.startsWith(prefix)) return;
        await sendDiscordMessage(message, message.channelId, "Please provide a task using /run task:<description>.", undefined, message.id);
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
      await sendDiscordMessage(message, 
        message.channelId,
        "Sofia accepted your task.\nJob ID: " + handle.id + "\nI will post the result when it finishes.",
        undefined,
        message.id,
      );
      void waitForDiscordTask(handle, { signal: discordAbort.signal }).then(async (result) => {
        const prefix = result.status === "completed" ? "Sofia completed the task." : "Sofia job " + result.status + ".";
        const response = prefix + "\nJob ID: " + result.id + "\n" + result.summary;
        const safeResponse = response.length > 1700 ? response.slice(0, 1690) + "… (truncated)" : response;
        await sendDiscordMessage(message, message.channelId, safeResponse);
        await deps.jobRuntime?.markNotificationDelivered?.(result.id);
      }).catch(async () => {
        try {
          await sendDiscordMessage(message, 
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
        await sendDiscordMessage(message, 
          message.channelId,
          "Sofia could not start or complete that task. Check the server logs for a redacted error.",
          undefined,
          message.id,
        );
      } catch {
        console.error("Discord command error reply delivery failed.");
      }
    }
  };
  if (discordTransport) await discordTransport.start(discordAbort.signal, handleDiscordMessage);
  if (discordGatewayTransport) await discordGatewayTransport.start(discordAbort.signal, handleDiscordMessage);

  // Retry recovery notifications while the process is alive. A crashed worker may
  // still have an unexpired lease at startup; periodic list() calls let the runtime
  // mark it interrupted once that lease expires, then notify the user without a new restart.
  const notificationInFlight = new Set<string>();
  const notifyRecoveredJobs = async (): Promise<void> => {
    if (!deps.jobRuntime || (!discordTransport && !discordGatewayTransport) || discordAbort.signal.aborted) return;
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
        const sender = discordTransport ?? discordGatewayTransport;
        await sender?.sendMessage(job.notificationChannelId, message);
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
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    discordAbort.abort();
    if (typeof discordRecoveryTimer !== "undefined") clearInterval(discordRecoveryTimer);
    void discordTransport?.stop();
    void discordGatewayTransport?.stop();
    void telegramRuntime?.stop().catch(() => console.error("Telegram integration shutdown failed."));
    server.close(() => {
      if ("closeSessionStore" in deps && typeof deps.closeSessionStore === "function") deps.closeSessionStore();
    });
  });
}
