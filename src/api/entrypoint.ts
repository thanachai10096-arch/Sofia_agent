import { chmodSync, mkdirSync } from "node:fs";
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
import { createTelegramMessagingRuntime } from "../integrations/messaging/telegram-runtime.js";
import { ApprovalBroker } from "../agent/approval-broker.js";
import { SqliteApprovalDecisionStore } from "../agent/sqlite-approval-store.js";
import { UpstashApprovalDecisionStore } from "../agent/upstash-approval-store.js";

const processStartedAt = Date.now();
const workspace = path.resolve(process.env.SOFIA_WORKSPACE ?? process.cwd());
const apiKeys: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
const rawApiKeys = process.env.SOFIA_API_KEYS_JSON?.trim();
if (rawApiKeys) {
  let parsed: unknown;
  try { parsed = JSON.parse(rawApiKeys); }
  catch { throw new Error("SOFIA_API_KEYS_JSON must be a JSON object mapping API keys to scope arrays."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SOFIA_API_KEYS_JSON must be a JSON object mapping API keys to scope arrays.");
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!key.trim() || key.length > 512 || /[\x00-\x20\x7f]/u.test(key) ||
        !Array.isArray(value) || value.length === 0 ||
        !value.every((scope) => typeof scope === "string" && /^[a-z][a-z0-9:_-]{0,63}$/u.test(scope))) {
      throw new Error("SOFIA_API_KEYS_JSON contains an invalid API key or scope list.");
    }
    apiKeys[key] = [...new Set(value as string[])];
  }
} else {
  const apiKey = process.env.SOFIA_API_KEY?.trim();
  if (!apiKey) throw new Error("Set SOFIA_API_KEY or SOFIA_API_KEYS_JSON.");
  const fallbackScopes = (process.env.SOFIA_API_SCOPES ?? "agent:run,agent:read").split(",").map((s) => s.trim()).filter(Boolean);
  if (fallbackScopes.length === 0 || !fallbackScopes.every((scope) => /^[a-z][a-z0-9:_-]{0,63}$/u.test(scope))) {
    throw new Error("SOFIA_API_SCOPES contains an invalid scope.");
  }
  apiKeys[apiKey] = [...new Set(fallbackScopes)];
}
if (Object.keys(apiKeys).length === 0) throw new Error("At least one API key is required.");
const allApiScopes = Object.values(apiKeys).flat();
if (Object.keys(apiKeys).length > 1) {
  // Process-mode child commands share the service account's filesystem view.
  // Require a container boundary before accepting multiple independent tenants.
  if (process.env.SOFIA_SANDBOX_MODE !== "docker") {
    throw new Error("Multiple API principals require SOFIA_SANDBOX_MODE=docker; process mode does not isolate tenant filesystems.");
  }
  if (!/^.+@sha256:[a-f0-9]{64}$/u.test(process.env.SOFIA_SANDBOX_IMAGE?.trim() ?? "")) {
    throw new Error("Multiple API principals require SOFIA_SANDBOX_IMAGE to be pinned by sha256 digest.");
  }
  if (allApiScopes.some((scope) => scope.startsWith("desktop:"))) {
    throw new Error("Desktop scopes are disabled for multi-principal API hosts until desktop execution has a per-tenant OS boundary.");
  }
}
const configuredScopes = new Set(allApiScopes);
const runStoreDirectory = path.resolve(
  process.env.SOFIA_RUN_STORE_DIR ?? path.join(workspace, ".sofia", "api-runs"),
);
mkdirSync(runStoreDirectory, { recursive: true, mode: 0o700 });
let closeApprovalStore: (() => void) | undefined;
let approvalBroker: ApprovalBroker | undefined;
let approvalHandler: import("../agent/approval-broker.js").ApprovalHandler | undefined;
if (process.env.SOFIA_APPROVAL_ENABLED?.trim().toLowerCase() === "true") {
  if (!configuredScopes.has("approval:manage")) throw new Error("SOFIA_APPROVAL_ENABLED requires approval:manage in at least one configured API key scope list.");
  const storeKind = (process.env.SOFIA_APPROVAL_STORE ?? "sqlite").trim().toLowerCase();
  if (storeKind === "redis") {
    const url = process.env.UPSTASH_REDIS_REST_URL?.trim() || process.env.REDIS_REST_URL?.trim();
    const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() || process.env.REDIS_REST_TOKEN?.trim();
    if (!url || !token) throw new Error("Redis approval storage requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.");
    const store = new UpstashApprovalDecisionStore({
      url,
      token,
      prefix: process.env.SOFIA_APPROVAL_REDIS_PREFIX?.trim() || "sofia",
    });
    approvalBroker = new ApprovalBroker({ store });
    approvalHandler = approvalBroker.handle;
  } else if (storeKind === "sqlite") {
    const store = await SqliteApprovalDecisionStore.open(
      process.env.SOFIA_APPROVAL_STORE_PATH?.trim() || path.join(workspace, ".sofia", "approvals.sqlite"),
    );
    closeApprovalStore = () => store.close();
    approvalBroker = new ApprovalBroker({ store });
    approvalHandler = approvalBroker.handle;
  } else {
    throw new Error("SOFIA_APPROVAL_STORE must be sqlite or redis.");
  }
}
// Inject the handler before createSofiaAgentDependencies builds its Brain factory.
// Mutating deps.approval afterwards does not update the factory's captured dependency.
const deps = await createSofiaAgentDependenciesWithSessions(workspace, approvalHandler);
if (approvalBroker) deps.approvalBroker = approvalBroker;

// API users never choose a filesystem path. Their opaque project ID is mapped to
// a private directory under a hash of the authenticated API principal.
const userWorkspaceRoot = path.resolve(
  process.env.SOFIA_USER_WORKSPACES_DIR ?? path.join(workspace, ".sofia", "user-workspaces"),
);
mkdirSync(userWorkspaceRoot, { recursive: true, mode: 0o700 });
const restrictWorkspaceDirectory = (directory: string) => {
  if (process.platform !== "win32") chmodSync(directory, 0o700);
};
restrictWorkspaceDirectory(userWorkspaceRoot);
const maxCachedWorkspaces = (() => {
  const value = Number(process.env.SOFIA_MAX_CACHED_WORKSPACES ?? 256);
  if (!Number.isSafeInteger(value) || value < 1 || value > 5000) throw new Error("SOFIA_MAX_CACHED_WORKSPACES must be an integer from 1 to 5000.");
  return value;
})();
type WorkspaceDependencies = Awaited<ReturnType<typeof createSofiaAgentDependenciesWithSessions>>;
const workspaceDependencies = new Map<string, Promise<WorkspaceDependencies>>();
const resolveWorkspaceDependencies = async (principalId: string, workspaceId: string) => {
  if (!/^[a-f0-9]{32}$/u.test(principalId)) throw new Error("Workspace resolution requires an authenticated API principal.");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(workspaceId)) throw new Error("Invalid project workspace ID.");
  const cacheKey = principalId + ":" + workspaceId;
  let pending = workspaceDependencies.get(cacheKey);
  if (!pending) {
    if (workspaceDependencies.size >= maxCachedWorkspaces) throw new Error("Workspace runtime capacity reached; increase SOFIA_MAX_CACHED_WORKSPACES or restart after cleanup.");
    const ownerRoot = path.join(userWorkspaceRoot, principalId);
    const projectRoot = path.join(ownerRoot, createHash("sha256").update(workspaceId).digest("hex"));
    mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(projectRoot, ".sofia"), { recursive: true, mode: 0o700 });
    restrictWorkspaceDirectory(ownerRoot);
    restrictWorkspaceDirectory(projectRoot);
    restrictWorkspaceDirectory(path.join(projectRoot, ".sofia"));
    pending = createSofiaAgentDependenciesWithSessions(
      projectRoot,
      approvalHandler,
      path.join(projectRoot, ".sofia", "sessions.sqlite"),
      deps.securityController,
    );
    workspaceDependencies.set(cacheKey, pending);
    void pending.catch(() => {
      if (workspaceDependencies.get(cacheKey) === pending) workspaceDependencies.delete(cacheKey);
    });
  }
  const resolved = await pending;
  if (approvalBroker) resolved.approvalBroker = approvalBroker;
  return resolved;
};
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
let discordTransport: ReturnType<typeof createDiscordInteractionTransport> | undefined;
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
    additionalCommandNames: ["status", "cancel", "resume"],
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

const server = createSofiaApi(deps, {
  apiKeys,
  allowedOrigins: (process.env.SOFIA_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  runStore: new FileRunRecordStore(runStoreDirectory),
  resolveWorkspaceDependencies,
  usageStorePath: path.join(workspace, ".sofia", "api-usage.json"),
  ...(discordTransport ? { discordInteractionRoute: { transport: discordTransport } } : {}),
});
const port = Number(process.env.PORT ?? 3000);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
server.on("close", () => {
  deps.closeSessionStore();
  for (const pending of workspaceDependencies.values()) {
    void pending.then(async (workspaceDeps) => {
      workspaceDeps.closeSessionStore();
      await workspaceDeps.closeBrowserProfiles?.();
    }).catch(() => undefined);
  }
  closeApprovalStore?.();
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
