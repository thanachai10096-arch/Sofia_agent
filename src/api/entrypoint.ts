import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { createSofiaApi } from "./server.js";
import { FileRunRecordStore } from "./run-record-store.js";
import { createSofiaAgentDependenciesWithSessions } from "../models/factory.js";
import { createDiscordInteractionTransport } from "../integrations/messaging/discord-interaction-transport.js";
import { createDiscordGatewayTransport } from "../integrations/messaging/discord-gateway-transport.js";
import type { VerifiedDiscordMessage } from "../integrations/messaging/discord.js";
import { FileChatMessageDeduplicator } from "../integrations/file-chat-deduplicator.js";
import { createDiscordSharedChatHandler } from "../integrations/messaging/discord-shared-chat-handler.js";
import { parseDiscordIdAllowlist } from "../integrations/messaging/discord-allowlist.js";
import { createTelegramMessagingRuntime, parseTelegramChatAllowlist } from "../integrations/messaging/telegram-runtime.js";
import { createDiscordApprovalBroker } from "../integrations/messaging/discord-approval-broker.js";

const processStartedAt = Date.now();
const workspace = path.resolve(process.env.SOFIA_WORKSPACE ?? process.cwd());
const apiKey = process.env.SOFIA_API_KEY?.trim();
if (!apiKey) throw new Error("SOFIA_API_KEY is required.");
const scopes = (process.env.SOFIA_API_SCOPES ?? "agent:run,agent:read").split(",").map((s) => s.trim()).filter(Boolean);
const runStoreDirectory = path.resolve(
  process.env.SOFIA_RUN_STORE_DIR ?? path.join(workspace, ".sofia", "api-runs"),
);
mkdirSync(runStoreDirectory, { recursive: true, mode: 0o700 });
let discordTransport: ReturnType<typeof createDiscordInteractionTransport> | undefined;
const approvalBroker = createDiscordApprovalBroker({
  sendMessage: async (channelId, message) => {
    if (!discordTransport) throw new Error("Discord approval transport is unavailable.");
    return discordTransport.sendMessage(channelId, message);
  },
});
const deps = await createSofiaAgentDependenciesWithSessions(workspace, approvalBroker.handle);
// Telegram is an optional, explicitly enabled bridge into the existing Sofia API/Core.
const telegramRuntime = createTelegramMessagingRuntime(process.env, workspace);

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
let discordGatewayTransport: ReturnType<typeof createDiscordGatewayTransport> | undefined;
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
    additionalCommandNames: ["status", "cancel", "resume", "approve", "deny"],
    allowedUserIds: discordUserIds,
    allowedChannelIds: discordChannelIds,
    onError: (event, status) => console.error("Discord transport error:", event, status ?? ""),
  });
  const discordDeduplicator = new FileChatMessageDeduplicator(
    path.resolve(process.env.SOFIA_CHAT_DEDUPE_DIR ?? path.join(workspace, ".sofia", "chat-dedupe")),
  );
  const handleDiscordMessage = async (message: VerifiedDiscordMessage): Promise<void> => {
    try {
      deps.securityController?.assertRunning();
      if (!deps.jobRuntime) throw new Error("Durable job runtime is unavailable.");
      const principalId = "discord:" + message.author.id;
      if (!discordUserIds.has(message.author.id) || !discordChannelIds.has(message.channelId)) {
        await discordTransport?.sendMessage(message.channelId, "You are not authorized to approve or run Sofia in this channel.", undefined, message.id);
        return;
      }
      const command = message.content.trim().split(/\s+/, 1)[0] ?? "";
      if (command === "/approve" || command === "/deny") {
        const decision = approvalBroker.respond({
          channelId: message.channelId,
          authorId: message.author.id,
          content: message.content,
        });
        const response = decision === "approved"
          ? "Approval accepted. Sofia may now execute the exact reviewed action."
          : decision === "denied"
            ? "Approval denied. The action will not be executed."
            : decision === "unauthorized"
              ? "This approval request belongs to another user or channel."
              : decision === "action_mismatch"
                ? "The action hash does not match. The action remains blocked."
                : decision === "not_found"
                  ? "Approval request not found or expired."
                  : "Invalid approval command. Use /approve <request-id> <action-hash> or /deny <request-id> <action-hash>.";
        await discordTransport?.sendMessage(message.channelId, response, undefined, message.id);
        return;
      }
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
      const handleDiscordChat = createDiscordSharedChatHandler({
        runtime: deps.jobRuntime,
        sender: discordTransport!,
        deduplicator: discordDeduplicator,
        allowedUserIds: new Set(discordUserIds),
        allowedChannelIds: new Set(discordChannelIds),
        signal: discordAbort.signal,
        onError: (kind) => console.error("Discord messaging event:", kind),
      });
      const reply = await handleDiscordChat(message);
      if (reply) {
        // The shared dispatcher returns the normal acceptance acknowledgement;
        // edit the deferred interaction while its short-lived token is valid.
        await discordTransport?.sendMessage(message.channelId, reply, undefined, message.id);
      }
    } catch (error) {
      // Log only the error class, never task text, credentials, interaction tokens, or raw provider messages.
      console.error("Discord message handler failed:", error instanceof Error ? error.name : "UnknownError");
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
  };
  await discordTransport.start(discordAbort.signal, handleDiscordMessage);
  // Gateway intake is opt-in and reuses the exact same allowlisted shared handler.
  // MESSAGE_CONTENT must also be enabled for the application in Discord Developer Portal.
  if (process.env.DISCORD_GATEWAY_ENABLED?.trim().toLowerCase() === "true") {
    try {
      discordGatewayTransport = createDiscordGatewayTransport({
        botToken: discordBotToken,
        onError: (event, status) => console.error("Discord Gateway event:", event, status ?? ""),
      });
      await discordGatewayTransport.start(discordAbort.signal, handleDiscordMessage);
    } catch (error) {
      // An optional Gateway failure must not take down the existing API or slash-command transport.
      discordGatewayTransport = undefined;
      console.error("Discord Gateway disabled:", error instanceof Error ? error.name : "UnknownError");
    }
  }

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

const notificationDestinations = new Set<string>();
// Telegram is the only adapter that submits runs through this public API.
// Discord jobs use the in-process JobRuntime and keep their own verified route.
// Public API request bodies cannot expand the Telegram destination allowlist.
const rawTelegramChatIds = process.env.TELEGRAM_ALLOWED_CHAT_IDS?.trim();
if (telegramRuntime && rawTelegramChatIds) {
  try {
    for (const chatId of parseTelegramChatAllowlist(rawTelegramChatIds)) {
      notificationDestinations.add("telegram:" + chatId);
    }
  } catch {
    // The adapter already fails closed on invalid configuration.
  }
}
const apiKeyId = createHash("sha256").update(apiKey).digest("hex").slice(0, 32);

const server = createSofiaApi(deps, {
  apiKeys: { [apiKey]: scopes },
  notificationChannelAllowlistByKey: { [apiKeyId]: [...notificationDestinations] },
  allowedOrigins: (process.env.SOFIA_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  runStore: new FileRunRecordStore(runStoreDirectory),
  usageStorePath: path.join(workspace, ".sofia", "api-usage.json"),
  ...(discordTransport ? { discordInteractionRoute: { transport: discordTransport } } : {}),
});
const port = Number(process.env.PORT ?? 3000);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
server.on("close", () => {
  approvalBroker.close();
  deps.closeSessionStore();
  void deps.closeBrowserProfiles?.().catch(() => console.error("Browser profile shutdown failed."));
});
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
    server.close();
  });
}
