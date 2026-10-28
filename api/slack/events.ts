import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { verifySlackRequest } from "../../src/integrations/messaging/platform-security.js";

export const config = { api: { bodyParser: false } };

const MAX_BODY_BYTES = 64 * 1024;
const API_TIMEOUT_MS = 1_200;
const SLACK_REPLY_TIMEOUT_MS = 800;

interface SlackEnvelope {
  type?: unknown;
  challenge?: unknown;
  event_id?: unknown;
  event?: {
    type?: unknown;
    subtype?: unknown;
    bot_id?: unknown;
    user?: unknown;
    channel?: unknown;
    text?: unknown;
    ts?: unknown;
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

function allowlist(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((entry) => entry.trim())
    .filter((entry) => /^[A-Z0-9]{1,32}$/.test(entry)));
}

function validSlackId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9]{1,32}$/.test(value);
}

function safeApiBase(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Slack Events API receiver for Vercel Node Functions.
 * Keep body parsing disabled so signatures cover the exact raw bytes Slack sent.
 * Configure signing secret, API credentials, and explicit user/channel allowlists
 * in Preview first; never expose these values to the browser.
 */
export default async function slackEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    reply(res, 405, { error: "method_not_allowed" });
    return;
  }

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    reply(res, 503, { error: "slack_integration_not_configured" });
    return;
  }

  const rawBody = await readRawBody(req);
  if (!rawBody) {
    reply(res, 413, { error: "request_too_large" });
    return;
  }

  const signature = req.headers["x-slack-signature"];
  const timestamp = req.headers["x-slack-request-timestamp"];
  if (!verifySlackRequest({
    signingSecret,
    signature: typeof signature === "string" ? signature : undefined,
    timestamp: typeof timestamp === "string" ? timestamp : undefined,
    rawBody,
  })) {
    reply(res, 401, { error: "invalid_slack_signature" });
    return;
  }

  let envelope: SlackEnvelope;
  try {
    envelope = JSON.parse(rawBody.toString("utf8")) as SlackEnvelope;
  } catch {
    reply(res, 400, { error: "invalid_request_body" });
    return;
  }

  // Slack requires this signed challenge response when configuring an Events URL.
  if (envelope.type === "url_verification") {
    if (typeof envelope.challenge !== "string" || envelope.challenge.length > 2_048) {
      reply(res, 400, { error: "invalid_url_challenge" });
      return;
    }
    reply(res, 200, { challenge: envelope.challenge });
    return;
  }

  // Acknowledge non-message events without triggering work.
  if (envelope.type !== "event_callback" || !envelope.event ||
      envelope.event.type !== "message" || envelope.event.subtype || envelope.event.bot_id) {
    reply(res, 200, { ok: true });
    return;
  }

  const event = envelope.event;
  if (typeof envelope.event_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(envelope.event_id) ||
      !validSlackId(event.user) || !validSlackId(event.channel) ||
      typeof event.text !== "string" || !event.text.trim() || event.text.length > 4_000 ||
      typeof event.ts !== "string" || !/^\d{1,16}(?:\.\d{1,9})?$/.test(event.ts)) {
    reply(res, 200, { ok: true });
    return;
  }

  // Empty allowlists deny all events; deployments must opt in to permitted users/channels.
  const allowedUsers = allowlist(process.env.SLACK_ALLOWED_USER_IDS);
  const allowedChannels = allowlist(process.env.SLACK_ALLOWED_CHANNEL_IDS);
  if (!allowedUsers.has(event.user) || !allowedChannels.has(event.channel)) {
    reply(res, 200, { ok: true });
    return;
  }

  const apiBaseValue = process.env.SOFIA_API_BASE_URL;
  const apiKey = process.env.SOFIA_API_KEY;
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!apiBaseValue || !apiKey || !botToken || !/^xox[baprs]-[A-Za-z0-9-]{10,512}$/.test(botToken)) {
    reply(res, 503, { error: "slack_integration_not_configured" });
    return;
  }
  const base = safeApiBase(apiBaseValue);
  if (!base) {
    reply(res, 503, { error: "sofia_api_url_invalid" });
    return;
  }

  const idempotencyKey = "slack_" + createHash("sha256").update(envelope.event_id).digest("hex");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let runId: string | undefined;
  let runStatus = "queued";
  try {
    const response = await fetch(new URL("/v1/agent/runs", base), {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        task: event.text.trim(),
        async: true,
        context: `Origin: Slack message event. Slack user ID: ${event.user}. Channel ID: ${event.channel}.`,
      }),
      signal: controller.signal,
    });
    let data: { id?: unknown; status?: unknown } = {};
    try { data = await response.json() as typeof data; } catch { /* never forward provider response bodies */ }
    if (!response.ok || typeof data.id !== "string" || data.id.length === 0 || data.id.length > 256) {
      // Acknowledge only after the Sofia API confirms run creation. A retry is
      // safe because the same Slack event reuses this stable idempotency key.
      reply(res, 503, { error: "sofia_run_not_accepted" });
      return;
    }
    runId = data.id;
    runStatus = typeof data.status === "string" ? data.status.slice(0, 64) : "queued";
  } catch {
    // Slack may retry; the stable idempotency key prevents duplicate runs if the API accepted it.
    reply(res, 503, { error: "sofia_api_unavailable" });
    return;
  } finally {
    clearTimeout(timeout);
  }

  // Reply to the originating channel. Keep the request bounded so Slack receives its ACK promptly.
  const replyController = new AbortController();
  const replyTimeout = setTimeout(() => replyController.abort(), SLACK_REPLY_TIMEOUT_MS);
  try {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        channel: event.channel,
        thread_ts: event.ts,
        text: `Sofia accepted your task. Run ID: ${runId} (status: ${runStatus}).`,
      }),
      signal: replyController.signal,
    });
  } catch {
    // Run creation is authoritative; delivery failures must not cause a duplicate task retry.
  } finally {
    clearTimeout(replyTimeout);
  }
  reply(res, 200, { ok: true });
}
