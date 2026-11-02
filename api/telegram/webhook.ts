import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

export const config = {
  api: { bodyParser: false },
};

const MAX_BODY_BYTES = 64 * 1024;
const API_TIMEOUT_MS = 1_800;

interface TelegramUpdate {
  update_id?: unknown;
  message?: {
    message_id?: unknown;
    text?: unknown;
    chat?: { id?: unknown; type?: unknown };
    from?: { id?: unknown; is_bot?: unknown };
  };
}

function reply(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(JSON.stringify(body));
}

async function readRawBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function constantTimeSecretEqual(actual: string | undefined, expected: string): boolean {
  if (!actual || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual, "utf8"), Buffer.from(expected, "utf8"));
}

function allowlist(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((part) => part.trim()).filter((part) => /^-?\d{1,24}$/.test(part)));
}

function validId(value: unknown): value is number | string {
  return (typeof value === "number" && Number.isSafeInteger(value)) ||
    (typeof value === "string" && /^-?\d{1,24}$/.test(value));
}

async function sendTelegramMessage(token: string, chatId: number | string, text: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3_900) }),
    signal,
  });
  if (!response.ok) throw new Error("telegram_delivery_failed");
  const payload = await response.json() as { ok?: unknown };
  if (payload.ok !== true) throw new Error("telegram_delivery_failed");
}

/**
 * Vercel Telegram webhook adapter.
 *
 * This is a channel ingress adapter only: it forwards accepted work to the
 * configured Sofia API. It does not run Sofia Core or provide durable job
 * execution by itself. See docs/VERCEL_TELEGRAM_READINESS.md.
 */
export default async function telegramWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    reply(res, 405, { error: "method_not_allowed" });
    return;
  }

  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const apiBase = process.env.SOFIA_API_BASE_URL;
  const apiKey = process.env.SOFIA_UPSTREAM_API_KEY;
  if (!webhookSecret || !botToken || !apiBase || !apiKey) {
    reply(res, 503, { error: "telegram_integration_not_configured" });
    return;
  }
  if (!constantTimeSecretEqual(req.headers["x-telegram-bot-api-secret-token"] as string | undefined, webhookSecret)) {
    reply(res, 401, { error: "invalid_telegram_webhook_secret" });
    return;
  }

  const rawBody = await readRawBody(req);
  if (!rawBody) {
    reply(res, 413, { error: "request_too_large" });
    return;
  }

  let update: TelegramUpdate;
  try {
    update = JSON.parse(rawBody.toString("utf8")) as TelegramUpdate;
  } catch {
    reply(res, 400, { error: "invalid_request_body" });
    return;
  }

  const message = update.message;
  if (!Number.isSafeInteger(update.update_id) || !message || !validId(message.chat?.id) ||
      !validId(message.from?.id) || message.from?.is_bot === true ||
      typeof message.text !== "string" || !message.text.trim()) {
    // Ignore unsupported Telegram update types without causing endless retries.
    reply(res, 200, { ok: true, ignored: true });
    return;
  }

  const allowedUsers = allowlist(process.env.TELEGRAM_ALLOWED_USER_IDS);
  const allowedChats = allowlist(process.env.TELEGRAM_ALLOWED_CHAT_IDS);
  const userId = String(message.from.id);
  const chatId = String(message.chat.id);
  // Both allowlists are mandatory; empty lists deny all senders and chats.
  if (!allowedUsers.has(userId) || !allowedChats.has(chatId)) {
    reply(res, 200, { ok: true, ignored: true });
    return;
  }

  const text = message.text.trim();
  if (text.length > 4_000) {
    reply(res, 200, { ok: true, rejected: "message_too_long" });
    return;
  }

  let base: URL;
  try {
    base = new URL(apiBase);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
      throw new Error("invalid base URL");
    }
  } catch {
    reply(res, 503, { error: "sofia_api_url_invalid" });
    return;
  }

  const idempotencyKey = "telegram_" + createHash("sha256").update(String(update.update_id)).digest("hex");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(new URL("/v1/agent/runs", base), {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        task: text,
        async: true,
        context: `Origin: Telegram. Telegram user ID: ${userId}. Chat ID: ${chatId}.`,
      }),
      signal: controller.signal,
    });
    let data: { id?: unknown } = {};
    try { data = await response.json() as typeof data; } catch { /* fail closed below */ }
    if (!response.ok) {
      // Let Telegram retry transient upstream failures instead of acknowledging
      // and permanently dropping a message that Sofia could not accept.
      const retryable = response.status === 408 || response.status === 425 ||
        response.status === 429 || response.status >= 500;
      if (retryable) {
        reply(res, 503, { error: "sofia_api_temporarily_unavailable" });
      } else {
        // Permanent request/auth/policy errors should not create a retry loop.
        reply(res, 200, { ok: true, accepted: false, error: "sofia_api_rejected_request" });
      }
      return;
    }
    if (typeof data.id !== "string" || !data.id.trim()) {
      // A successful but malformed upstream response is ambiguous: ask Telegram
      // to retry with the same update-scoped idempotency key.
      reply(res, 502, { error: "sofia_api_invalid_response" });
      return;
    }

    // Acknowledge only after the upstream API has accepted the request.
    // This upstream API currently uses process-local idempotency and is
    // not a shared durable queue; completion delivery is also outside this ingress-only endpoint.
    try {
      await sendTelegramMessage(botToken, message.chat.id, `Sofia รับงานแล้ว\nJob ID: ${data.id}`, controller.signal);
    } catch {
      // Telegram may retry the webhook; the stable idempotency key prevents a
      // second logical run when the upstream API's idempotency store is shared.
    }
    reply(res, 200, { ok: true, accepted: true, jobId: data.id });
  } catch {
    reply(res, 503, { error: "sofia_api_unavailable" });
  } finally {
    clearTimeout(timeout);
  }
}
