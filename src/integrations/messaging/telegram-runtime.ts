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
    const safeError = typeof run.error === "string"
      ? String(redactSecrets(run.error)).replace(/[\r\n\t]+/g, " ").slice(0, 240).trim()
      : "";
    text = "Sofia task " + status + ".\nRun ID: " + input.runId +
      (status === "failed"
        ? (safeError ? "\nReason: " + safeError : "\nNo safe error detail was returned by the API.")
        : "");
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

/**
 * Parse a JSON object mapping immutable Telegram user IDs to individual Sofia
 * API keys. The map must exactly cover the allowlist: no missing or extra users.
 * API-key values are never included in validation errors.
 */
export function parseTelegramUserApiKeys(
  value: string,
  allowedUsers: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("TELEGRAM_USER_API_KEYS must be a JSON object mapping Telegram user IDs to API keys.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("TELEGRAM_USER_API_KEYS must be a JSON object mapping Telegram user IDs to API keys.");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length !== allowedUsers.size ||
      entries.some(([userId]) => !allowedUsers.has(userId)) ||
      [...allowedUsers].some((userId) => !Object.prototype.hasOwnProperty.call(parsed, userId))) {
    throw new Error("TELEGRAM_USER_API_KEYS must contain exactly one API key for every allowed Telegram user ID.");
  }
  const result = new Map<string, string>();
  for (const [userId, candidate] of entries) {
    if (!/^\d{1,20}$/.test(userId) || typeof candidate !== "string" ||
        !candidate.trim() || candidate.length > 4_096 || /[\x00-\x1f\x7f]/.test(candidate)) {
      throw new Error("TELEGRAM_USER_API_KEYS contains an invalid user ID or API key.");
    }
    result.set(userId, candidate.trim());
  }
  return result;
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
  /** JSON object: {"<telegram-user-id>":"<user-specific-sofia-api-key>"} */
  TELEGRAM_USER_API_KEYS?: string;
  SOFIA_API_BASE_URL?: string;
  RAILWAY_PUBLIC_DOMAIN?: string;
}

/**
 * Build the optional Telegram bridge using the existing Sofia API and command
 * dispatcher. Missing/invalid optional configuration disables Telegram without
 * taking the core API offline. Multi-user deployments require a complete
 * per-sender API-key map because API-key identity owns persistent Memory.
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
  const rawUserApiKeys = env.TELEGRAM_USER_API_KEYS?.trim();
  const railwayDomain = env.RAILWAY_PUBLIC_DOMAIN?.trim();
  const baseUrl = env.SOFIA_API_BASE_URL?.trim() ||
    (railwayDomain ? "https://" + railwayDomain.replace(/^https?:\/\//i, "").replace(/\/$/, "") : "");

  if (!token || !rawUsers || !rawChats || (!apiKey && !rawUserApiKeys) || !baseUrl) {
    onWarning("Telegram integration disabled: token, API connection, and explicit user/chat allowlists are required.");
    return undefined;
  }

  try {
    const allowedUsers = parseTelegramUserAllowlist(rawUsers);
    const allowedChats = parseTelegramChatAllowlist(rawChats);
    // The API scopes persistent Memory by API-key identity, not Telegram sender ID.
    // Multi-user mode therefore requires an exact per-sender credential map.
    const userApiKeys = rawUserApiKeys
      ? parseTelegramUserApiKeys(rawUserApiKeys, allowedUsers)
      : allowedUsers.size === 1 && apiKey
        ? new Map([[...allowedUsers][0]!, apiKey])
        : undefined;
    if (!userApiKeys) {
      onWarning("Telegram integration disabled: configure TELEGRAM_USER_API_KEYS with a separate API key for every allowed user, or allow exactly one user with SOFIA_API_KEY.");
      return undefined;
    }
    const clientsByUser = new Map([...userApiKeys].map(([userId, key]) => [
      userId,
      new SofiaClient({ apiKey: key, baseUrl }),
    ]));
    const defaultClient = clientsByUser.values().next().value as SofiaClient | undefined;
    if (!defaultClient) {
      onWarning("Telegram integration disabled: no per-user Sofia API clients are configured.");
      return undefined;
    }
    const accessPolicy = {
      isAllowed(input: { platform: "telegram" | "discord" | "slack"; senderId: string; conversationId: string }) {
        return input.platform === "telegram" &&
          allowedUsers.has(input.senderId) &&
          allowedChats.has(input.conversationId);
      },
    };
    const deduplicator = new FileChatMessageDeduplicator(path.join(workspace, ".sofia", "chat-dedupe"));
    let gateway: MessagingGateway | undefined;
    const handler = createSofiaMessagingHandler({
      client: defaultClient,
      clientForMessage: (message) => clientsByUser.get(message.identity.userId),
      accessPolicy, deduplicator, commandPrefix: "/run",
      onAccepted: ({ runId, message }) => {
        const senderClient = clientsByUser.get(message.identity.userId);
        if (!senderClient) return;
        // Poll in the background so one long task does not block incoming Telegram updates.
        void reportTelegramRunCompletion({
          runId,
          conversationId: message.identity.conversationId,
          waitForRun: (id, options) => senderClient.waitForRun(id, options),
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
      "TELEGRAM_USER_API_KEYS must be a JSON object mapping Telegram user IDs to API keys.",
      "TELEGRAM_USER_API_KEYS must contain exactly one API key for every allowed Telegram user ID.",
      "TELEGRAM_USER_API_KEYS contains an invalid user ID or API key.",
      "Telegram bot token has an invalid format.",
      "Telegram poll timeout must be an integer between 1 and 50 seconds.",
    ].includes(error.message) ? error.message : "Telegram configuration validation failed; check required variable values and API URL format.";
    onWarning("Telegram integration disabled: " + safeMessage);
    return undefined;
  }
}
