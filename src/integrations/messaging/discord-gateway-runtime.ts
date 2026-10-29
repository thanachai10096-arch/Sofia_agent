import path from "node:path";
import { SofiaClient } from "../../sdk/client.js";
import { redactSecrets } from "../../security/guard.js";
import { FileChatMessageDeduplicator } from "../file-chat-deduplicator.js";
import { parseDiscordIdAllowlist } from "./discord-allowlist.js";
import { createDiscordAdapter } from "./discord.js";
import { createDiscordGatewayTransport } from "./discord-gateway-transport.js";
import { createMessagingGateway, type MessagingGateway } from "./gateway.js";
import { createMessagingAccessCheck, createSofiaMessagingHandler } from "./sofia-handler.js";
import type { OutboundMessage } from "./types.js";

export interface DiscordGatewayMessagingRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
}
interface DiscordRunResult {
  id: string;
  status: string;
  result?: { output?: string };
  error?: string;
}
export interface DiscordGatewayMessagingEnvironment {
  SOFIA_DISCORD_GATEWAY_ENABLED?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_ALLOWED_USER_IDS?: string;
  DISCORD_ALLOWED_CHANNEL_IDS?: string;
  SOFIA_API_KEY?: string;
  SOFIA_API_BASE_URL?: string;
  RAILWAY_PUBLIC_DOMAIN?: string;
}

/** Report the actual durable run result to the originating Discord channel. */
export async function reportDiscordRunCompletion(input: {
  runId: string;
  conversationId: string;
  waitForRun: (id: string, options: { timeoutMs: number; intervalMs: number }) => Promise<DiscordRunResult>;
  send: (message: OutboundMessage) => Promise<boolean>;
  onWarning?: (event: string) => void;
}): Promise<void> {
  let run: DiscordRunResult;
  try {
    run = await input.waitForRun(input.runId, { timeoutMs: 30 * 60 * 1_000, intervalMs: 1_000 });
  } catch {
    try {
      await input.send({
        conversationId: input.conversationId,
        text: "Sofia could not retrieve the final result for run " + input.runId + ". The task may still be running; check the Sofia run status.",
      });
    } catch { input.onWarning?.("completion_delivery_failed"); }
    return;
  }
  const output = typeof run.result?.output === "string" ? String(redactSecrets(run.result.output)).trim() : "";
  let text: string;
  if (run.status === "completed") {
    text = "Sofia completed the task.\nRun ID: " + input.runId +
      (output ? "\n\n" + output : "\n\nThe run completed but returned no text output.");
  } else {
    const status = ["failed", "cancelled", "queued", "running"].includes(run.status) ? run.status : "unknown";
    const safeError = typeof run.error === "string"
      ? String(redactSecrets(run.error)).replace(/[\r\n\t]+/g, " ").slice(0, 240).trim()
      : "";
    text = "Sofia task " + status + ".\nRun ID: " + input.runId +
      (status === "failed" ? (safeError ? "\nReason: " + safeError : "\nNo safe error detail was returned by the API.") : "");
  }
  try {
    const delivered = await input.send({ conversationId: input.conversationId, text: text.slice(0, 1_900) });
    if (!delivered) input.onWarning?.("completion_delivery_failed");
  } catch { input.onWarning?.("completion_delivery_failed"); }
}

/**
 * Optional ordinary-message Discord bridge. Uses the authenticated Gateway
 * transport and the same Sofia API client, access policy, deduplicator and
 * MessagingGateway as Telegram; it does not create another Sofia runtime.
 */
export function createDiscordGatewayMessagingRuntime(
  env: DiscordGatewayMessagingEnvironment = process.env,
  workspace = process.cwd(),
  onWarning: (message: string) => void = (message) => console.error(message),
): DiscordGatewayMessagingRuntime | undefined {
  if (env.SOFIA_DISCORD_GATEWAY_ENABLED !== "true") return undefined;
  const token = env.DISCORD_BOT_TOKEN?.trim();
  const rawUsers = env.DISCORD_ALLOWED_USER_IDS?.trim();
  const rawChannels = env.DISCORD_ALLOWED_CHANNEL_IDS?.trim();
  const apiKey = env.SOFIA_API_KEY?.trim();
  const railwayDomain = env.RAILWAY_PUBLIC_DOMAIN?.trim();
  const baseUrl = env.SOFIA_API_BASE_URL?.trim() ||
    (railwayDomain ? "https://" + railwayDomain.replace(/^https?:\/\//i, "").replace(/\/$/, "") : "");
  if (!token || !rawUsers || !rawChannels || !apiKey || !baseUrl) {
    onWarning("Discord Gateway disabled: bot token, Sofia API connection, and explicit user/channel allowlists are required.");
    return undefined;
  }
  try {
    const allowedUsers = parseDiscordIdAllowlist(rawUsers, "DISCORD_ALLOWED_USER_IDS");
    const allowedChannels = parseDiscordIdAllowlist(rawChannels, "DISCORD_ALLOWED_CHANNEL_IDS");
    const client = new SofiaClient({ apiKey, baseUrl });
    const accessPolicy = {
      isAllowed(input: { platform: "telegram" | "discord" | "slack"; senderId: string; conversationId: string }) {
        return input.platform === "discord" && allowedUsers.includes(input.senderId) && allowedChannels.includes(input.conversationId);
      },
    };
    const deduplicator = new FileChatMessageDeduplicator(path.join(workspace, ".sofia", "chat-dedupe"));
    let gateway: MessagingGateway | undefined;
    const handler = createSofiaMessagingHandler({
      client,
      accessPolicy,
      deduplicator,
      commandPrefix: "/run",
      naturalLanguageMode: "natural-language",
      onAccepted: ({ runId, message }) => {
        void reportDiscordRunCompletion({
          runId,
          conversationId: message.identity.conversationId,
          waitForRun: (id, options) => client.waitForRun(id, options),
          send: (outbound) => gateway ? gateway.send("discord", outbound) : Promise.resolve(false),
          onWarning: (event) => onWarning("Discord Gateway warning: " + event + "."),
        });
      },
    });
    const adapter = createDiscordAdapter(createDiscordGatewayTransport({
      botToken: token,
      allowedUserIds: allowedUsers,
      allowedChannelIds: allowedChannels,
      onError: (event, status) => onWarning("Discord Gateway " + event + (status ? " (HTTP " + status + ")" : "") + "."),
    }));
    gateway = createMessagingGateway({
      enabled: true,
      adapters: [adapter],
      allowUser: createMessagingAccessCheck(accessPolicy),
      maxMessagesPerWindow: 5,
      rateWindowMs: 60_000,
      onMessage: (message) => handler(message),
      logger: {
        info: (event) => onWarning("Discord Gateway event: " + event + "."),
        warn: (event) => onWarning("Discord Gateway warning: " + event + "."),
      },
    });
    return { start: () => gateway.start(), stop: () => gateway.stop() };
  } catch (error) {
    const safeMessage = error instanceof Error && [
      "DISCORD_ALLOWED_USER_IDS must contain at least one Discord ID.",
      "DISCORD_ALLOWED_CHANNEL_IDS must contain at least one Discord ID.",
      "DISCORD_ALLOWED_USER_IDS contains an invalid Discord ID.",
      "DISCORD_ALLOWED_CHANNEL_IDS contains an invalid Discord ID.",
      "DISCORD_ALLOWED_USER_IDS contains duplicate Discord IDs.",
      "DISCORD_ALLOWED_CHANNEL_IDS contains duplicate Discord IDs.",
    ].includes(error.message) ? error.message : "Discord Gateway configuration is invalid.";
    onWarning("Discord Gateway disabled: " + safeMessage);
    return undefined;
  }
}
