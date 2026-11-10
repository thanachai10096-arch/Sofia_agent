import path from "node:path";
import { createHash } from "node:crypto";
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
  /** Deliver an approval notice only to the private chat bound to the owning API key. */
  notifyApproval(ownerKeyId: string, text: string): Promise<boolean>;
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

function parseTelegramIds(value: string, pattern: RegExp, name: string): ReadonlySet<string> {
  const entries = value.split(",").map((entry) => entry.trim());
  if (!entries.length || entries.some((entry) => !entry || !pattern.test(entry))) {
    throw new Error(name + " must be a comma-separated list of valid numeric IDs.");
  }
  const ids = new Set(entries);
  if (ids.size !== entries.length) throw new Error(name + " must not contain duplicate IDs.");
  return ids;
}

/**
 * Parse per-user API credentials without ever logging their values.
 * Every allowed sender must have a unique key so API-key-scoped memory
 * and sessions remain private to that Telegram identity.
 */
export function parseTelegramUserApiKeys(
  value: string,
  allowedUsers: ReadonlySet<string>,
  reservedKeys: ReadonlySet<string> = new Set(),
): ReadonlyMap<string, string> {
  const invalid = () => new Error("TELEGRAM_USER_API_KEYS_JSON must map every allowed Telegram user ID to a unique non-empty API key that is not shared with another Sofia identity.");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw invalid(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid();
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (allowedUsers.size === 0 || entries.length !== allowedUsers.size ||
      entries.some(([userId, key]) => !allowedUsers.has(userId) || typeof key !== "string" || !key.trim()) ||
      new Set(entries.map(([, key]) => (key as string).trim())).size !== entries.length ||
      entries.some(([, key]) => reservedKeys.has((key as string).trim()))) throw invalid();
  return new Map<string, string>(entries.map(([userId, key]) => [userId, (key as string).trim()] as const));
}

/**
 * Approval decisions use the sender-specific API key, so the API derives the
 * owner from authenticated credentials rather than trusting a Telegram user ID.
 */
export async function handleTelegramApprovalCommand(
  client: Pick<SofiaClient, "listApprovals" | "decideApproval">,
  commandText: string,
): Promise<string | undefined> {
  const [command = "", ...args] = commandText.trim().split(/\s+/);
  if (command === "/approvals") {
    if (args.length) return "Usage: /approvals";
    const { approvals } = await client.listApprovals();
    if (!approvals.length) return "ไม่มีคำขออนุมัติที่รอดำเนินการ";
    return approvals.slice(0, 10).map((item, index) =>
      (index + 1) + ". " + item.toolName + " [" + item.risk + "]\n" +
      "ID: " + item.id + "\n" +
      "หมดอายุ: " + new Date(item.expiresAt).toISOString() + "\n" +
      "Action hash: " + item.actionHash
    ).join("\n\n");
  }
  if (command === "/approve" || command === "/reject") {
    if (args.length !== 2) return "Usage: " + command + " <approval-id> <action-hash>";
    await client.decideApproval(args[0]!, args[1]!, command === "/approve");
    return command === "/approve"
      ? "อนุมัติแล้ว Sofia จะดำเนินการต่อเมื่อคำขอยังอยู่ในสถานะรอดำเนินการ"
      : "ปฏิเสธคำขอแล้ว";
  }
  return undefined;
}

export interface TelegramMessagingEnvironment {
  SOFIA_MESSAGING_ENABLED?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ALLOWED_USER_IDS?: string;
  TELEGRAM_ALLOWED_CHAT_IDS?: string;
  SOFIA_API_KEY?: string;
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
  options: { fetchImpl?: typeof fetch } = {},
): TelegramMessagingRuntime | undefined {
  const requested = env.SOFIA_MESSAGING_ENABLED === "true";
  if (!requested) return undefined;

  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const rawUsers = env.TELEGRAM_ALLOWED_USER_IDS?.trim();
  const rawChats = env.TELEGRAM_ALLOWED_CHAT_IDS?.trim();
  const apiKey = env.SOFIA_API_KEY?.trim();
  const rawUserApiKeys = env.TELEGRAM_USER_API_KEYS_JSON?.trim();
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
    const userApiKeys = rawUserApiKeys
      ? parseTelegramUserApiKeys(rawUserApiKeys, allowedUsers, apiKey ? new Set([apiKey]) : new Set())
      : undefined;
    if (allowedUsers.size > 1 && !userApiKeys) {
      throw new Error("Per-user Telegram API keys are required when multiple Telegram users are allowed.");
    }
    const clients = new Map<string, SofiaClient>();
    const ownerKeyToTelegramUser = new Map<string, string>();
    for (const userId of allowedUsers) {
      const key = userApiKeys?.get(userId) ?? apiKey;
      if (key) ownerKeyToTelegramUser.set(createHash("sha256").update(key).digest("hex").slice(0, 32), userId);
    }
    const clientForUser = (userId: string) => {
      const key = userApiKeys?.get(userId) ?? apiKey;
      if (!key) throw new Error("No Sofia API key is configured for this Telegram user.");
      let client = clients.get(userId);
      if (!client) {
        client = new SofiaClient({ apiKey: key, baseUrl });
        clients.set(userId, client);
      }
      return client;
    };
    const client = clientForUser([...allowedUsers][0]!);
    const accessPolicy = {
      isAllowed(input: { platform: "telegram" | "discord" | "slack"; senderId: string; conversationId: string }) {
        return input.platform === "telegram" &&
          allowedUsers.has(input.senderId) &&
          allowedChats.has(input.conversationId) &&
          (!userApiKeys || userApiKeys.has(input.senderId));
      },
    };
    const dedupeDirectory = path.resolve(env.SOFIA_CHAT_DEDUPE_DIR ?? path.join(workspace, ".sofia", "chat-dedupe"));
    const deduplicator = new FileChatMessageDeduplicator(dedupeDirectory);
    let gateway: MessagingGateway | undefined;
    const handler = createSofiaMessagingHandler({
      client, accessPolicy, deduplicator, commandPrefix: "/run",
      clientForMessage: (message) => clientForUser(message.identity.userId),
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
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
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
      onMessage: async (message) => {
        const command = message.text.trim().split(/\s+/, 1)[0] ?? "";
        if (command === "/approvals" || command === "/approve" || command === "/reject") {
          try {
            const reply = await handleTelegramApprovalCommand(clientForUser(message.identity.userId), message.text);
            if (reply) await gateway?.send("telegram", { conversationId: message.identity.conversationId, text: reply });
          } catch (error) {
            const status = error instanceof SofiaApiError ? error.status : 0;
            const reply = status === 403
              ? "บัญชีนี้ไม่มีสิทธิ์จัดการคำขออนุมัติ"
              : status === 409
                ? "คำขอนี้หมดอายุ ถูกตัดสินแล้ว หรือ Action Hash ไม่ตรง กรุณาใช้ /approvals ตรวจสอบใหม่"
                : "ไม่สามารถจัดการคำขออนุมัติได้ในขณะนี้";
            await gateway?.send("telegram", { conversationId: message.identity.conversationId, text: reply });
          }
          return;
        }
        await handler(message);
      },
      logger: {
        info: (event) => onWarning("Telegram messaging event: " + event + "."),
        warn: (event) => onWarning("Telegram messaging warning: " + event + "."),
      },
    });
    return {
      start: () => gateway.start(),
      stop: () => gateway.stop(),
      notifyApproval: async (ownerKeyId: string, text: string) => {
        const userId = ownerKeyToTelegramUser.get(ownerKeyId);
        // Approval notices are sent only as a private DM. A group/channel ID is
        // never accepted from the run request or used as an outbound target.
        if (!userId || !allowedUsers.has(userId) || !allowedChats.has(userId) || !gateway) return false;
        const delivered = await gateway.send("telegram", { conversationId: userId, text: text.slice(0, 3_500) });
        if (!delivered) onWarning("Telegram approval notification delivery failed.");
        return delivered;
      },
    };
  } catch (error) {
    // Report only the static validation message from our own constructors. Never log
    // environment values, bot tokens, API keys, or provider response bodies.
    const safeMessage = error instanceof Error && [
      "TELEGRAM_ALLOWED_USER_IDS must be a comma-separated list of valid numeric IDs.",
      "TELEGRAM_ALLOWED_CHAT_IDS must be a comma-separated list of valid numeric IDs.",
      "TELEGRAM_ALLOWED_USER_IDS must not contain duplicate IDs.",
      "TELEGRAM_ALLOWED_CHAT_IDS must not contain duplicate IDs.",
      "Per-user Telegram API keys are required when multiple Telegram users are allowed.",
      "TELEGRAM_USER_API_KEYS_JSON must map every allowed Telegram user ID to a unique non-empty API key.",
      "Telegram bot token has an invalid format.",
      "Telegram poll timeout must be an integer between 1 and 50 seconds.",
    ].includes(error.message) ? error.message : "Telegram configuration validation failed; check required variable values and API URL format.";
    onWarning("Telegram integration disabled: " + safeMessage);
    return undefined;
  }
}
