import path from "node:path";
import { SofiaApiError, SofiaClient } from "../../sdk/client.js";
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

function classifyRunWaitFailure(error: unknown): string {
  let current: unknown = error;
  let timedOut = false;
  let aborted = false;
  // SofiaClient wraps the last transient API error as Error.cause on timeout.
  // Walk a bounded cause chain so the original HTTP status is not lost.
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof SofiaApiError) return "api_http_" + current.status;
    if (/timed out waiting/i.test(current.message)) timedOut = true;
    if (/abort/i.test(current.message)) aborted = true;
    current = "cause" in current ? current.cause : undefined;
  }
  if (timedOut) return "timeout";
  if (aborted) return "aborted";
  return "network_or_unknown";
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
  onEvent?: (event: string) => void;
}): Promise<void> {
  let run: TelegramRunResult;
  try {
    run = await input.waitForRun(input.runId, { timeoutMs: 30 * 60 * 1_000, intervalMs: 1_000 });
  } catch (error) {
    const failureKind = classifyRunWaitFailure(error);
    input.onWarning?.("telegram_run_wait_failed run_id=" + input.runId + " kind=" + failureKind);
    try {
      const delivered = await input.send({
        conversationId: input.conversationId,
        text: "Sofia could not retrieve the final result for run " + input.runId + ". The task may still be running; check the Sofia run status.",
      });
      if (delivered) input.onEvent?.("telegram_run_status_notice_delivered run_id=" + input.runId);
      else input.onWarning?.("telegram_completion_delivery_failed run_id=" + input.runId);
    } catch {
      input.onWarning?.("telegram_completion_delivery_failed run_id=" + input.runId);
    }
    return;
  }

  input.onEvent?.("telegram_run_terminal run_id=" + input.runId + " status=" + run.status);
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
    if (delivered) input.onEvent?.("telegram_run_result_delivered run_id=" + input.runId);
    else input.onWarning?.("telegram_completion_delivery_failed run_id=" + input.runId);
  } catch {
    input.onWarning?.("telegram_completion_delivery_failed run_id=" + input.runId);
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

/**
 * Map every allowlisted Telegram user to a distinct API key. A shared bot key
 * would collapse all senders into one Sofia principal and mix their memories.
 */
export function parseTelegramUserApiKeys(
  value: string,
  allowedUsers: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  if (typeof value !== "string" || value.length > 64_000) {
    throw new Error("TELEGRAM_USER_API_KEYS_JSON must map every allowed user to a distinct API key.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch {
    throw new Error("TELEGRAM_USER_API_KEYS_JSON must contain a valid JSON object.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("TELEGRAM_USER_API_KEYS_JSON must contain a valid JSON object.");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length !== allowedUsers.size) {
    throw new Error("TELEGRAM_USER_API_KEYS_JSON must map every allowed user to a distinct API key.");
  }
  const result = new Map<string, string>();
  const uniqueKeys = new Set<string>();
  for (const [userId, valueForUser] of entries) {
    if (!allowedUsers.has(userId) || typeof valueForUser !== "string" ||
        !valueForUser.trim() || valueForUser !== valueForUser.trim() ||
        valueForUser.length > 4_096 || uniqueKeys.has(valueForUser)) {
      throw new Error("TELEGRAM_USER_API_KEYS_JSON must map every allowed user to a distinct API key.");
    }
    uniqueKeys.add(valueForUser);
    result.set(userId, valueForUser);
  }
  for (const userId of allowedUsers) {
    if (!result.has(userId)) {
      throw new Error("TELEGRAM_USER_API_KEYS_JSON must map every allowed user to a distinct API key.");
    }
  }
  return result;
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
  TELEGRAM_USER_API_KEYS_JSON?: string;
  SOFIA_API_BASE_URL?: string;
  RAILWAY_PUBLIC_DOMAIN?: string;
  SOFIA_CHAT_DEDUPE_DIR?: string;
}

/**
 * Build the optional Telegram bridge using the existing Sofia API and command
 * dispatcher. Missing/invalid optional configuration disables Telegram without
 * taking the core API offline. Ordinary text and /run commands can start agent work
 * through the shared handler; authorization and deduplication still apply.
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
  const rawUserApiKeys = env.TELEGRAM_USER_API_KEYS_JSON;
  const railwayDomain = env.RAILWAY_PUBLIC_DOMAIN?.trim();
  const baseUrl = env.SOFIA_API_BASE_URL?.trim() ||
    (railwayDomain ? "https://" + railwayDomain.replace(/^https?:\/\//i, "").replace(/\/$/, "") : "");

  if (!token || !rawUsers || !rawChats || !rawUserApiKeys || !baseUrl) {
    onWarning("Telegram integration disabled: token, API connection, explicit allowlists, and per-user API keys are required.");
    return undefined;
  }

  try {
    const allowedUsers = parseTelegramUserAllowlist(rawUsers);
    const allowedChats = parseTelegramChatAllowlist(rawChats);
    const userApiKeys = parseTelegramUserApiKeys(rawUserApiKeys, allowedUsers);
    const clientForUser = (userId: string) => {
      const apiKey = userApiKeys.get(userId);
      if (!apiKey) throw new Error("Telegram sender has no isolated Sofia API identity.");
      return new SofiaClient({ apiKey, baseUrl });
    };
    const accessPolicy = {
      isAllowed(input: { platform: "telegram" | "discord" | "slack"; senderId: string; conversationId: string }) {
        return input.platform === "telegram" &&
          allowedUsers.has(input.senderId) &&
          allowedChats.has(input.conversationId);
      },
    };
    const dedupeDirectory = path.resolve(env.SOFIA_CHAT_DEDUPE_DIR ?? path.join(workspace, ".sofia", "chat-dedupe"));
    const deduplicator = new FileChatMessageDeduplicator(dedupeDirectory);
    let gateway: MessagingGateway | undefined;
    const handler = createSofiaMessagingHandler({
      clientForMessage: (message) => clientForUser(message.identity.userId),
      accessPolicy, deduplicator, commandPrefix: "/run",
      onAccepted: ({ runId, runStatus, message }) => {
        onWarning("Telegram messaging event: telegram_run_accepted run_id=" + runId + " status=" + runStatus + ".");
        // Poll in the background so one long task does not block incoming Telegram updates.
        void reportTelegramRunCompletion({
          runId,
          conversationId: message.identity.conversationId,
          waitForRun: (id, options) => clientForUser(message.identity.userId).waitForRun(id, options),
          send: (outbound) => gateway
            ? gateway.send("telegram", outbound)
            : Promise.resolve(false),
          onWarning: (event) => onWarning("Telegram messaging warning: " + event + "."),
          onEvent: (event) => onWarning("Telegram messaging event: " + event + "."),
        });
      },
    });
    const adapter = createTelegramAdapter(createTelegramHttpTransport({
      token,
      onError: (event, status, failureKind) => onWarning(
        "Telegram transport " + event +
        (failureKind ? " [" + failureKind + "]" : "") +
        (typeof status === "number" ? " (HTTP " + status + ")" : "") + ".",
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
