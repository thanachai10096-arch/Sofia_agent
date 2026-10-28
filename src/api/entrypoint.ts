import { mkdirSync } from "node:fs";
import path from "node:path";
import { createSofiaApi } from "./server.js";
import { FileRunRecordStore } from "./run-record-store.js";
import { createSofiaAgentDependenciesWithSessions } from "../models/factory.js";
import { createDiscordInteractionTransport } from "../integrations/messaging/discord-interaction-transport.js";
import { parseDiscordIdAllowlist } from "../integrations/messaging/discord-allowlist.js";
import { buildDiscordSessionContext, submitDiscordTask, waitForDiscordTask } from "../integrations/messaging/discord-durable-job.js";
import { messagingSessionKey } from "../integrations/messaging/session-key.js";
import { createTelegramMessagingRuntime } from "../integrations/messaging/telegram-runtime.js";
import { createMatrixMessagingRuntime } from "../integrations/messaging/matrix-runtime.js";
import { createSlackMessagingRuntime } from "../integrations/messaging/slack-runtime.js";
import { createLineMessagingRuntime } from "../integrations/messaging/line-runtime.js";
import { createWhatsAppMessagingRuntime } from "../integrations/messaging/whatsapp-runtime.js";
import { redactSecrets } from "../security/guard.js";

const processStartedAt = Date.now();
const workspace = path.resolve(process.env.SOFIA_WORKSPACE ?? process.cwd());
const apiKey = process.env.SOFIA_API_KEY?.trim();
if (!apiKey) throw new Error("SOFIA_API_KEY is required.");
const scopes = (process.env.SOFIA_API_SCOPES ?? "agent:run,agent:read").split(",").map((s) => s.trim()).filter(Boolean);
mkdirSync(path.join(workspace, ".sofia", "api-runs"), { recursive: true, mode: 0o700 });
const deps = await createSofiaAgentDependenciesWithSessions(workspace, undefined, process.env.SOFIA_SESSION_DB_PATH?.trim() || undefined);
// Telegram is an optional, explicitly enabled bridge into the existing Sofia API/Core.
const telegramRuntime = createTelegramMessagingRuntime(process.env, workspace);
// Matrix polling bridge reuses the existing Sofia API and shared messaging gateway.
const matrixRuntime = createMatrixMessagingRuntime(process.env, workspace);
const slackRuntime = createSlackMessagingRuntime(process.env, workspace);
const lineRuntime = createLineMessagingRuntime(process.env, workspace);
const whatsAppRuntime = createWhatsAppMessagingRuntime(process.env, workspace);

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
        userId: message.author.id,
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
  ...(process.env.SOFIA_MESSAGING_CONTEXT_SECRET?.trim() ? { messagingContextSecret: process.env.SOFIA_MESSAGING_CONTEXT_SECRET.trim() } : {}),
  ...(discordTransport ? { discordInteractionRoute: { transport: discordTransport } } : {}),
  ...(slackRuntime ? { slackEventsRoute: { transport: slackRuntime.transport } } : {}),
  ...(lineRuntime ? { lineWebhookRoute: { transport: lineRuntime.transport } } : {}),
  ...(whatsAppRuntime ? { whatsAppWebhookRoute: { transport: whatsAppRuntime.transport } } : {}),
  onCronExecutionFinished: async (schedule, execution, job) => {
    const target = schedule.notificationTarget;
    if (!target) return false;
    // The Discord owner ID is independently bound to the trusted adapter identity.
    if (target.platform === "discord" && schedule.ownerKeyId !== "discord:" + target.userId) return false;
    const summary = typeof job?.result?.summary === "string" ? String(redactSecrets(job.result.summary)).trim() : "";
    const status = execution.status;
    const message = status === "completed"
      ? "⏰ Sofia scheduled task completed.\nSchedule: " + schedule.name + "\n" + (summary || "The task completed without a text summary.")
      : "⏰ Sofia scheduled task " + status + ".\nSchedule: " + schedule.name + "\nCheck Sofia schedule history for details.";
    const outbound = { conversationId: target.conversationId, text: message.slice(0, 1700) };
    switch (target.platform) {
      case "discord":
        if (!discordTransport) return false;
        await discordTransport.sendMessage(target.conversationId, outbound.text);
        return true;
      case "telegram": return telegramRuntime ? telegramRuntime.send(outbound) : false;
      case "matrix": return matrixRuntime ? matrixRuntime.send(outbound) : false;
      case "slack": return slackRuntime ? slackRuntime.send(outbound) : false;
      case "line": return lineRuntime ? lineRuntime.send(outbound) : false;
      case "whatsapp": return whatsAppRuntime ? whatsAppRuntime.send(outbound) : false;
    }
  },
});
const port = Number(process.env.PORT ?? 3000);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
server.listen(port, "0.0.0.0", () => {
  console.log("Sofia Agent API listening on port " + port);
  void telegramRuntime?.start().catch((error) => {
    console.error("Telegram integration failed to start:", error instanceof Error ? error.name : "UnknownError");
  });
  void matrixRuntime?.start().catch((error) => {
    console.error("Matrix integration failed to start:", error instanceof Error ? error.name : "UnknownError");
  });
  void slackRuntime?.start().catch((error) => {
    console.error("Slack integration failed to start:", error instanceof Error ? error.name : "UnknownError");
  });
  void lineRuntime?.start().catch((error) => {
    console.error("LINE integration failed to start:", error instanceof Error ? error.name : "UnknownError");
  });
  void whatsAppRuntime?.start().catch((error) => {
    console.error("WhatsApp integration failed to start:", error instanceof Error ? error.name : "UnknownError");
  });
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    discordAbort.abort();
    if (typeof discordRecoveryTimer !== "undefined") clearInterval(discordRecoveryTimer);
    void discordTransport?.stop();
    void telegramRuntime?.stop().catch(() => console.error("Telegram integration shutdown failed."));
    void matrixRuntime?.stop().catch(() => console.error("Matrix integration shutdown failed."));
    void slackRuntime?.stop().catch(() => console.error("Slack integration shutdown failed."));
    void lineRuntime?.stop().catch(() => console.error("LINE integration shutdown failed."));
    void whatsAppRuntime?.stop().catch(() => console.error("WhatsApp integration shutdown failed."));
    server.close(() => {
      void deps.closeSessionStore().catch(() => console.error("Sofia session/MCP shutdown failed."));
    });
  });
}
