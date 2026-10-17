import { verifyDiscordRequest } from "./platform-security.js";
import type { DiscordTransport, VerifiedDiscordMessage } from "./discord.js";

interface DiscordInteraction {
  type?: number;
  id?: string;
  channel_id?: string;
  application_id?: string;
  token?: string;
  data?: {
    name?: string;
    options?: Array<{ name?: string; type?: number; value?: unknown }>;
  };
  user?: { id?: string; username?: string; bot?: boolean };
  member?: { user?: { id?: string; username?: string; bot?: boolean } };
}
export interface DiscordInteractionRequest {
  headers: {
    "x-signature-ed25519"?: string;
    "x-signature-timestamp"?: string;
  };
  /** Exact bytes received over HTTP; do not JSON.parse or reserialize before passing. */
  rawBody: Uint8Array;
}
export interface DiscordInteractionResult {
  status: 200 | 400 | 401 | 503;
  body: Record<string, unknown>;
}
export type DiscordInteractionTransport = DiscordTransport & {
  handleRequest(input: DiscordInteractionRequest): Promise<DiscordInteractionResult>;
};
export interface DiscordInteractionTransportOptions {
  publicKeyHex: string;
  botToken: string;
  commandName?: string;
  taskOptionName?: string;
  commandPrefix?: string;
  fetchImpl?: typeof fetch;
  onError?: (event: "inbound_handler_failed" | "delivery_failed", status?: number) => void;
}

/**
 * Discord Interactions HTTP transport. Mount handleRequest on the application's
 * existing HTTPS route and pass the exact raw request body. It does not create a
 * second HTTP server or mutate Sofia's API server. Slash commands are deferred
 * immediately and their original response is edited through the interaction
 * webhook token, so the Discord loading state is cleared.
 */
export function createDiscordInteractionTransport(options: DiscordInteractionTransportOptions): DiscordInteractionTransport {
  if (!/^[0-9a-f]{64}$/i.test(options.publicKeyHex)) throw new Error("Discord public key must be 32-byte hex.");
  if (!/^[A-Za-z0-9._-]{20,256}$/.test(options.botToken)) throw new Error("Discord bot token has an invalid format.");
  const commandName = options.commandName ?? "run";
  const taskOptionName = options.taskOptionName ?? "task";
  const commandPrefix = options.commandPrefix ?? "/run";
  for (const [name, value] of [["commandName", commandName], ["taskOptionName", taskOptionName], ["commandPrefix", commandPrefix]] as const) {
    if (!value.trim() || value.length > 128 || /[\r\n\0]/.test(value)) throw new Error(`Invalid Discord ${name}.`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  let callback: ((message: VerifiedDiscordMessage) => Promise<void>) | undefined;
  let active = false;
  let controller: AbortController | undefined;
  const pendingInteractions = new Map<string, {
    applicationId: string;
    token: string;
    expiresAt: number;
    originalResponded: boolean;
  }>();

  function notify(event: "inbound_handler_failed" | "delivery_failed", status?: number): void {
    try { options.onError?.(event, status); } catch { /* logging must not alter transport behavior */ }
  }

  async function sendInteractionMessage(interactionId: string, text: string): Promise<{ messageId: string }> {
    const pending = pendingInteractions.get(interactionId);
    if (!pending || pending.expiresAt <= Date.now()) {
      pendingInteractions.delete(interactionId);
      throw new Error("Discord interaction token expired.");
    }
    if (!controller || controller.signal.aborted) throw new Error("Discord transport is stopped.");
    const original = !pending.originalResponded;
    const base = `https://discord.com/api/v10/webhooks/${encodeURIComponent(pending.applicationId)}/${encodeURIComponent(pending.token)}`;
    const url = original ? `${base}/messages/@original` : base;
    try {
      const response = await fetchImpl(url, {
        method: original ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text }),
        signal: controller.signal,
      });
      if (!response.ok) {
        notify("delivery_failed", response.status);
        throw new Error("Discord interaction response failed.");
      }
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string") {
        throw new Error("Discord interaction response omitted message ID.");
      }
      pending.originalResponded = true;
      return { messageId: result.id };
    } catch {
      throw new Error("Discord interaction response failed.");
    }
  }

  const transport: DiscordInteractionTransport = {
    async start(signal, onMessage) {
      if (active) return;
      active = true;
      callback = onMessage;
      controller = new AbortController();
      const stopFromParent = () => controller?.abort(signal.reason);
      signal.addEventListener("abort", stopFromParent, { once: true });
      if (signal.aborted) stopFromParent();
    },
    async handleRequest(input) {
      if (!active || !callback || controller?.signal.aborted) {
        return { status: 503, body: { error: "Discord transport unavailable." } };
      }
      const timestamp = input.headers["x-signature-timestamp"];
      const signature = input.headers["x-signature-ed25519"];
      if (!verifyDiscordRequest({
        publicKeyHex: options.publicKeyHex,
        signatureHex: signature,
        timestamp,
        rawBody: input.rawBody,
      })) {
        return { status: 401, body: { error: "Invalid Discord request signature." } };
      }

      let interaction: DiscordInteraction;
      try {
        interaction = JSON.parse(Buffer.from(input.rawBody).toString("utf8")) as DiscordInteraction;
      } catch {
        return { status: 400, body: { error: "Invalid Discord request body." } };
      }
      if (interaction.type === 1) return { status: 200, body: { type: 1 } };
      if (interaction.type !== 2 || !interaction.id || !interaction.channel_id) {
        return { status: 400, body: { error: "Unsupported Discord interaction." } };
      }
      if (!/^\d{1,24}$/.test(interaction.id) || !/^\d{1,24}$/.test(interaction.channel_id) ||
          !interaction.application_id || !/^\d{1,24}$/.test(interaction.application_id) ||
          typeof interaction.token !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(interaction.token)) {
        return { status: 400, body: { error: "Invalid Discord interaction metadata." } };
      }
      const now = Date.now();
      for (const [id, pending] of pendingInteractions) {
        if (pending.expiresAt <= now) pendingInteractions.delete(id);
      }
      if (pendingInteractions.size >= 5_000) {
        return { status: 503, body: { error: "Discord interaction capacity reached." } };
      }
      if (interaction.data?.name !== commandName) {
        return { status: 200, body: { type: 4, data: { content: "Unsupported command.", flags: 64 } } };
      }
      const author = interaction.member?.user ?? interaction.user;
      if (!author?.id || !/^\d{1,24}$/.test(author.id) || author.bot) {
        return { status: 200, body: { type: 4, data: { content: "This command is not available to bots.", flags: 64 } } };
      }
      const taskValue = interaction.data.options?.find((option) => option.name === taskOptionName)?.value;
      const task = typeof taskValue === "string" ? taskValue : "";
      const event: VerifiedDiscordMessage = {
        signatureVerified: true,
        id: interaction.id,
        channelId: interaction.channel_id,
        author: { id: author.id, ...(author.username ? { username: author.username } : {}), bot: false },
        content: task ? `${commandPrefix} ${task}` : commandPrefix,
        createdAt: now,
        attachments: [],
      };
      pendingInteractions.set(event.id, {
        applicationId: interaction.application_id,
        token: interaction.token,
        expiresAt: now + 14 * 60_000,
        originalResponded: false,
      });
      const handler = callback;
      void Promise.resolve().then(() => handler(event)).then(async () => {
        const pending = pendingInteractions.get(event.id);
        if (pending && !pending.originalResponded) {
          try {
            await sendInteractionMessage(event.id, "This command did not produce a reply.");
          } catch {
            notify("inbound_handler_failed");
          }
        }
        pendingInteractions.delete(event.id);
      }).catch(async () => {
        const pending = pendingInteractions.get(event.id);
        if (pending && !pending.originalResponded) {
          try {
            await sendInteractionMessage(event.id, "Sofia could not process this command.");
          } catch {
            notify("inbound_handler_failed");
          }
        }
        pendingInteractions.delete(event.id);
        notify("inbound_handler_failed");
      });
      return { status: 200, body: { type: 5 } };
    },
    async sendMessage(channelId, text, replyToMessageId, interactionId) {
      if (!active || !controller || controller.signal.aborted) throw new Error("Discord transport is stopped.");
      if (interactionId && pendingInteractions.has(interactionId)) {
        return sendInteractionMessage(interactionId, text);
      }
      if (!/^\d{1,24}$/.test(channelId)) throw new Error("Invalid Discord channel ID.");
      try {
        const response = await fetchImpl(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: "POST",
          headers: {
            authorization: `Bot ${options.botToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            content: text,
            ...(replyToMessageId && /^\d{1,24}$/.test(replyToMessageId)
              ? { message_reference: { message_id: replyToMessageId, fail_if_not_exists: false } }
              : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          notify("delivery_failed", response.status);
          throw new Error("Discord message delivery failed.");
        }
        const result: unknown = await response.json();
        if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string") {
          throw new Error("Discord API response omitted message ID.");
        }
        return { messageId: result.id };
      } catch {
        throw new Error("Discord message delivery failed.");
      }
    },
    async stop() {
      active = false;
      callback = undefined;
      controller?.abort();
      controller = undefined;
      pendingInteractions.clear();
    },
  };
  return transport;
}
