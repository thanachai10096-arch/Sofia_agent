import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { verifyDiscordRequest } from "../../src/integrations/messaging/platform-security.js";

export const config = {
  api: { bodyParser: false },
};

const MAX_BODY_BYTES = 64 * 1024;
const API_TIMEOUT_MS = 1_800;

interface DiscordInteraction {
  type?: unknown;
  id?: unknown;
  application_id?: unknown;
  token?: unknown;
  channel_id?: unknown;
  data?: {
    name?: unknown;
    options?: Array<{ name?: unknown; value?: unknown }>;
  };
  user?: { id?: unknown; bot?: unknown };
  member?: { user?: { id?: unknown; bot?: unknown } };
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

function allowedIds(envValue: string | undefined): Set<string> {
  return new Set((envValue ?? "").split(",").map((value) => value.trim()).filter((value) => /^\d{1,24}$/.test(value)));
}

function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,24}$/.test(value);
}

/**
 * Vercel Node Function for Discord HTTP interactions.
 *
 * Configure the route in Discord only after deploying to Preview and completing
 * the documented acceptance checks. Keep bodyParser disabled so Ed25519
 * verification uses the exact bytes Discord sent.
 */
export default async function discordInteractions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    reply(res, 405, { error: "method_not_allowed" });
    return;
  }

  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  const apiBase = process.env.SOFIA_API_BASE_URL;
  const apiKey = process.env.SOFIA_API_KEY;
  if (!publicKey || !apiBase || !apiKey) {
    reply(res, 503, { error: "discord_integration_not_configured" });
    return;
  }

  const rawBody = await readRawBody(req);
  if (!rawBody) {
    reply(res, 413, { error: "request_too_large" });
    return;
  }

  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  if (!verifyDiscordRequest({
    publicKeyHex: publicKey,
    signatureHex: typeof signature === "string" ? signature : undefined,
    timestamp: typeof timestamp === "string" ? timestamp : undefined,
    rawBody,
  })) {
    reply(res, 401, { error: "invalid_discord_signature" });
    return;
  }

  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(rawBody.toString("utf8")) as DiscordInteraction;
  } catch {
    reply(res, 400, { error: "invalid_request_body" });
    return;
  }

  // Discord endpoint verification handshake.
  if (interaction.type === 1) {
    reply(res, 200, { type: 1 });
    return;
  }
  if (interaction.type !== 2 || !isSnowflake(interaction.id) ||
      !isSnowflake(interaction.application_id) || typeof interaction.token !== "string" ||
      !/^[A-Za-z0-9._-]{1,256}$/.test(interaction.token) || !isSnowflake(interaction.channel_id)) {
    reply(res, 400, { error: "unsupported_interaction" });
    return;
  }

  const commandName = process.env.DISCORD_COMMAND_NAME || "run";
  if (interaction.data?.name !== commandName) {
    reply(res, 200, { type: 4, data: { content: "Unsupported command.", flags: 64 } });
    return;
  }

  const user = interaction.member?.user ?? interaction.user;
  if (!user || !isSnowflake(user.id) || user.bot === true) {
    reply(res, 200, { type: 4, data: { content: "This command is not available to bots.", flags: 64 } });
    return;
  }

  // Empty allowlists deny all requests; access must be explicitly configured.
  const allowedUsers = allowedIds(process.env.DISCORD_ALLOWED_USER_IDS);
  const allowedChannels = allowedIds(process.env.DISCORD_ALLOWED_CHANNEL_IDS);
  if (!allowedUsers.has(user.id) || !allowedChannels.has(interaction.channel_id)) {
    reply(res, 200, { type: 4, data: { content: "Access denied.", flags: 64 } });
    return;
  }

  const taskOption = interaction.data.options?.find((option) => option.name === "task")?.value;
  if (typeof taskOption !== "string" || !taskOption.trim() || taskOption.length > 4_000) {
    reply(res, 200, { type: 4, data: { content: "Usage: /run task:<task, up to 4000 characters>", flags: 64 } });
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

  // Use a stable key for retries of the same Discord interaction. Sofia's API
  // currently documents this idempotency cache as process-local, so a durable
  // shared store remains a production acceptance requirement.
  const idempotencyKey = "discord_" + createHash("sha256").update(interaction.id).digest("hex");
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
        task: taskOption.trim(),
        async: true,
        context: `Origin: Discord interaction. Discord user ID: ${user.id}. Channel ID: ${interaction.channel_id}.`,
      }),
      signal: controller.signal,
    });
    let data: { id?: unknown; status?: unknown; error?: unknown } = {};
    try {
      data = await response.json() as typeof data;
    } catch {
      // Do not forward untrusted response bodies to Discord.
    }
    if (!response.ok || typeof data.id !== "string") {
      reply(res, 200, {
        type: 4,
        data: { content: response.status === 429
          ? "Sofia is rate-limiting requests. Please try again later."
          : "Sofia could not accept this task. Please try again later.", flags: 64 },
      });
      return;
    }
    reply(res, 200, {
      type: 4,
      data: {
        content: `Sofia accepted your task. Run ID: ${data.id} (status: ${typeof data.status === "string" ? data.status : "queued"}).`,
        flags: 64,
      },
    });
  } catch {
    // Fail closed; do not leak tokens, request content, or internal errors.
    reply(res, 200, {
      type: 4,
      data: { content: "Sofia API did not respond in time. Please retry; check run status before resubmitting.", flags: 64 },
    });
  } finally {
    clearTimeout(timeout);
  }
}
