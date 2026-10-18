import path from "node:path";
import { SofiaClient } from "../../sdk/client.js";
import { FileChatMessageDeduplicator } from "../file-chat-deduplicator.js";
import { createMessagingGateway, type MessagingGateway } from "./gateway.js";
import { createMessagingAccessCheck, createSofiaMessagingHandler } from "./sofia-handler.js";
import { createTelegramAdapter } from "./telegram.js";
import { createTelegramHttpTransport } from "./telegram-http-transport.js";

export interface TelegramMessagingRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
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
      isAllowed(input: { platform: "telegram" | "discord" | "slack"; senderId: string; conversationId: string }) {
        return input.platform === "telegram" &&
          allowedUsers.has(input.senderId) &&
          allowedChats.has(input.conversationId);
      },
    };
    const deduplicator = new FileChatMessageDeduplicator(path.join(workspace, ".sofia", "chat-dedupe"));
    const handler = createSofiaMessagingHandler({ client, accessPolicy, deduplicator, commandPrefix: "/run" });
    const adapter = createTelegramAdapter(createTelegramHttpTransport({
      token,
      onError: (event, status) => onWarning(
        "Telegram transport " + event + (status ? " (HTTP " + status + ")" : "") + ".",
      ),
    }));
    const gateway: MessagingGateway = createMessagingGateway({
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
  } catch {
    // Do not log configuration values or provider error text; malformed optional
    // Telegram configuration must not prevent the existing API from starting.
    onWarning("Telegram integration disabled: configuration validation failed.");
    return undefined;
  }
}
