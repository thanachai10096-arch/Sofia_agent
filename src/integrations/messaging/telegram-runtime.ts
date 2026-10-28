import path from "node:path";
import { SofiaClient } from "../../sdk/client.js";
import { FileChatMessageDeduplicator } from "../file-chat-deduplicator.js";
import { createMessagingGateway, type MessagingGateway } from "./gateway.js";
import { createMessagingAccessCheck, createSofiaMessagingHandler } from "./sofia-handler.js";
import { createTelegramAdapter } from "./telegram.js";
import { createTelegramHttpTransport } from "./telegram-http-transport.js";
import type { OutboundMessage } from "./types.js";
import { redactSecrets } from "../../security/guard.js";

export interface TelegramMessagingRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface TelegramRunResult {
  id: string;
  status: string;
  result?: { output?: string };
  error?: string;
}

/**
 * Wait for an accepted run to reach a terminal state and send its actual result
 * to the originating Telegram conversation. Kept separate for deterministic tests.
 */
export async function reportTelegramRunCompletion(input: {
  runId: string;
  conversationId: string;
  waitForRun: (id: string, options: { timeoutMs: number; intervalMs: number }) => Promise<TelegramRunResult>;
  send: (message: OutboundMessage) => Promise<boolean>;
  onWarning?: (event: string) => void;
}): Promise<void> {
  let run: TelegramRunResult;
  try {
    run = await input.waitForRun(input.runId, { timeoutMs: 30 * 60 * 1_000, intervalMs: 1_000 });
  } catch {
    try {
      await input.send({
        conversationId: input.conversationId,
        text: "Sofia could not retrieve the final result for run " + input.runId + ". The task may still be running; check the Sofia run status.",
      });
    } catch {
      input.onWarning?.("telegram_completion_delivery_failed");
    }
    return;
  }

  const output = typeof run.result?.output === "string"
    ? String(redactSecrets(run.result.output)).trim()
    : "";
  let text: string;
  if (run.status === "completed") {
    text = "✅ Sofia completed the task.\nRun ID: " + input.runId +
      (output ? "\n\n" + output : "\n\nThe run completed but returned no text output.");
  } else {
    const status = ["failed", "cancelled", "queued", "running"].includes(run.status) ? run.status : "unknown";
    // Provider/runtime errors may reveal infrastructure details. Keep them in the
    // authenticated run history and send only a safe user-facing status to chat.
    text = "Sofia task " + status + ".\nRun ID: " + input.runId +
      (status === "failed" ? "\nCheck the Sofia run history for details." : "");
  }

  try {
    const delivered = await input.send({ conversationId: input.conversationId, text });
    if (!delivered) input.onWarning?.("telegram_completion_delivery_failed");
  } catch {
    input.onWarning?.("telegram_completion_delivery_failed");
  }
}


/** Parse immutable Telegram user IDs; reject empty, malformed, or duplicate entries. */
export function parseTelegramUserAllowlist(value: string): ReadonlySet<string> {
  return parseTelegramIds(value, /^\d{1,20}$/, "TELEGRAM_ALLOWED_USER_IDS");
}

/** Telegram group/channel chat IDs may be negative; private chats are typically positive. */
export function parseTelegramChatAllowlist(value: string): ReadonlySet<string> {
  return parseTelegramIds(value, /^-?\d{1,20}$/, "TELEGRAM_ALLOWED_CHAT_IDS");
}

function parseTelegramIds(value: string, pattern: RegExp, name: string): ReadonlySet<string> {
  const entries = value.split(",").map((entry) => entry.trim());
  if (!entries.length || entries.some((entry) => !entry || !pattern.test(entry))) {
    throw new Error(name + " must be a comma-separated list of valid numeric IDs.");
  }
  const ids = new Set(entries);
  if (ids.size !== entries.length) throw new Error(name + " must not contain duplicate IDs.");
  return ids;
}

export interface TelegramMessagingEnvironment {
  SOFIA_MESSAGING_ENABLED?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ALLOWED_USER_IDS?: string;
  TELEGRAM_ALLOWED_CHAT_IDS?: string;
  SOFIA_API_KEY?: string;
  SOFIA_API_BASE_URL?: string;
  RAILWAY_PUBLIC_DOMAIN?: string;
}

/**
 * Build the optional Telegram bridge using the existing Sofia API and command
 * dispatcher. Missing/invalid optional configuration disables Telegram without
 * taking the core API offline. Only /run commands can start agent work.
 */
export function createTelegramMessagingRuntime(
  env: TelegramMessagingEnvironment = process.env,
  workspace = process.cwd(),
  onWarning: (message: string) => void = (message) => console.error(message),
): TelegramMessagingRuntime | undefined {
  const requested = env.SOFIA_MESSAGING_ENABLED === "true";
  if (!requested) return undefined;

  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const rawUsers = env.TELEGRAM_ALLOWED_USER_IDS?.trim();
  const rawChats = env.TELEGRAM_ALLOWED_CHAT_IDS?.trim();
  const apiKey = env.SOFIA_API_KEY?.trim();
  const railwayDomain = env.RAILWAY_PUBLIC_DOMAIN?.trim();
  const baseUrl = env.SOFIA_API_BASE_URL?.trim() ||
    (railwayDomain ? "https://" + railwayDomain.replace(/^https?:\/\//i, "").replace(/\/$/, "") : "");

  if (!token || !rawUsers || !rawChats || !apiKey || !baseUrl) {
    onWarning("Telegram integration disabled: token, API connection, and explicit user/chat allowlists are required.");
    return undefined;
  }

  try {
    const allowedUsers = parseTelegramUserAllowlist(rawUsers);
    const allowedChats = parseTelegramChatAllowlist(rawChats);
    const client = new SofiaClient({ apiKey, baseUrl });
    const accessPolicy = {
      isAllowed(input: { platform: "telegram" | "discord" | "slack" | "line"; senderId: string; conversationId: string }) {
        return input.platform === "telegram" &&
          allowedUsers.has(input.senderId) &&
          allowedChats.has(input.conversationId);
      },
    };
    const deduplicator = new FileChatMessageDeduplicator(path.join(workspace, ".sofia", "chat-dedupe"));
    let gateway: MessagingGateway | undefined;
    const handler = createSofiaMessagingHandler({
      client, accessPolicy, deduplicator, commandPrefix: "/run", allowPlainText: true,
      onAccepted: ({ runId, message }) => {
        // Poll in the background so one long task does not block incoming Telegram updates.
        void reportTelegramRunCompletion({
          runId,
          conversationId: message.identity.conversationId,
          waitForRun: (id, options) => client.waitForRun(id, options),
          send: (outbound) => gateway
            ? gateway.send("telegram", outbound)
            : Promise.resolve(false),
          onWarning: (event) => onWarning("Telegram messaging warning: " + event + "."),
        });
      },
    });
    const adapter = createTelegramAdapter(createTelegramHttpTransport({
      token,
      onError: (event, status) => onWarning(
        "Telegram transport " + event + (status ? " (HTTP " + status + ")" : "") + ".",
      ),
    }));
    gateway = createMessagingGateway({
      enabled: true,
      adapters: [adapter],
      allowUser: createMessagingAccessCheck(accessPolicy),
      // The command handler owns the shared dedupe claim. Do not claim it twice in the gateway.
      maxMessagesPerWindow: 5,
      rateWindowMs: 60_000,
      onMessage: (message) => handler(message),
      logger: {
        info: (event) => onWarning("Telegram messaging event: " + event + "."),
        warn: (event) => onWarning("Telegram messaging warning: " + event + "."),
      },
    });
    return {
      start: () => gateway.start(),
      stop: () => gateway.stop(),
    };
  } catch (error) {
    // Report only the static validation message from our own constructors. Never log
    // environment values, bot tokens, API keys, or provider response bodies.
    const safeMessage = error instanceof Error && [
      "TELEGRAM_ALLOWED_USER_IDS must be a comma-separated list of valid numeric IDs.",
      "TELEGRAM_ALLOWED_CHAT_IDS must be a comma-separated list of valid numeric IDs.",
      "TELEGRAM_ALLOWED_USER_IDS must not contain duplicate IDs.",
      "TELEGRAM_ALLOWED_CHAT_IDS must not contain duplicate IDs.",
      "Telegram bot token has an invalid format.",
      "Telegram poll timeout must be an integer between 1 and 50 seconds.",
    ].includes(error.message) ? error.message : "Telegram configuration validation failed; check required variable values and API URL format.";
    onWarning("Telegram integration disabled: " + safeMessage);
    return undefined;
  }
}
