import type { DiscordTransport, VerifiedDiscordMessage } from "./discord.js";

interface DiscordGatewayPayload {
  op?: number;
  d?: any;
  s?: number | null;
  t?: string | null;
}
export interface DiscordGatewayTransportOptions {
  botToken: string;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
  gatewayUrl?: string;
  heartbeatAckTimeoutMs?: number;
  onError?: (event: "gateway_ready" | "gateway_connect_failed" | "gateway_disconnected" | "gateway_auth_failed" | "gateway_invalid_session" | "message_handler_failed" | "delivery_failed", status?: number) => void;
}
type CloseReason = "reconnect" | "invalid_session" | "stopped";
const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const REQUIRED_INTENTS = (1 << 9) | (1 << 15); // GUILD_MESSAGES + MESSAGE_CONTENT

/** Discord Gateway transport for ordinary guild messages. Requires MESSAGE_CONTENT to be enabled in the Developer Portal. */
export function createDiscordGatewayTransport(options: DiscordGatewayTransportOptions): DiscordTransport {
  if (!/^[A-Za-z0-9._-]{20,256}$/.test(options.botToken)) throw new Error("Discord bot token has an invalid format.");
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  if (!WebSocketImpl) throw new Error("Discord Gateway requires a runtime with WebSocket support.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const ackTimeoutMs = options.heartbeatAckTimeoutMs ?? 45_000;
  if (!Number.isSafeInteger(ackTimeoutMs) || ackTimeoutMs < 5_000 || ackTimeoutMs > 120_000) {
    throw new Error("Invalid Discord heartbeat acknowledgement timeout.");
  }

  let stopped = true;
  let controller: AbortController | undefined;
  let loop: Promise<void> | undefined;
  let socket: WebSocket | undefined;
  let callback: ((message: VerifiedDiscordMessage) => Promise<void>) | undefined;
  let sequence: number | null = null;
  let sessionId: string | undefined;
  let resumeUrl: string | undefined;
  let botUserId: string | undefined;

  function notify(event: Parameters<NonNullable<DiscordGatewayTransportOptions["onError"]>>[0], status?: number): void {
    try { options.onError?.(event, status); } catch { /* diagnostics must not affect transport lifecycle */ }
  }
  function wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
  function send(payload: Record<string, unknown>): void {
    if (!socket || socket.readyState !== WebSocketImpl.OPEN) throw new Error("Discord Gateway socket is not open.");
    socket.send(JSON.stringify(payload));
  }

  async function connectOnce(url: string, signal: AbortSignal): Promise<CloseReason> {
    return new Promise<CloseReason>((resolve) => {
      let settled = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      let ackTimer: ReturnType<typeof setTimeout> | undefined;
      let heartbeatInterval = 0;
      let awaitingAck = false;
      let identified = false;
      const current = new WebSocketImpl(url);
      socket = current;
      const finish = (reason: CloseReason) => {
        if (settled) return;
        settled = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (ackTimer) clearTimeout(ackTimer);
        signal.removeEventListener("abort", abortSocket);
        try { current.close(); } catch { /* best effort */ }
        if (socket === current) socket = undefined;
        resolve(reason);
      };
      const abortSocket = () => finish("stopped");
      signal.addEventListener("abort", abortSocket, { once: true });
      if (signal.aborted) return finish("stopped");

      current.addEventListener("open", () => { /* HELLO starts the session */ });
      current.addEventListener("error", () => notify("gateway_connect_failed"));
      current.addEventListener("close", (event) => {
        if (settled) return;
        const code = (event as CloseEvent).code;
        if (code === 4004) notify("gateway_auth_failed", code);
        else notify("gateway_disconnected", code);
        finish(code === 4004 ? "stopped" : "reconnect");
      });
      current.addEventListener("message", (event) => {
        if (settled) return;
        let payload: DiscordGatewayPayload;
        try { payload = JSON.parse(String((event as MessageEvent).data)) as DiscordGatewayPayload; }
        catch { finish("reconnect"); return; }
        if (typeof payload.s === "number") sequence = payload.s;
        if (payload.op === 10) {
          const interval = Number(payload.d?.heartbeat_interval);
          if (!Number.isFinite(interval) || interval < 1_000 || interval > 300_000) return finish("reconnect");
          heartbeatInterval = interval;
          const heartbeat = () => {
            if (awaitingAck) return finish("reconnect");
            try {
              send({ op: 1, d: sequence });
              awaitingAck = true;
              if (ackTimer) clearTimeout(ackTimer);
              ackTimer = setTimeout(() => finish("reconnect"), ackTimeoutMs);
            } catch { finish("reconnect"); }
          };
          heartbeatTimer = setInterval(heartbeat, heartbeatInterval);
          heartbeat();
          if (sessionId && sequence !== null && resumeUrl) {
            send({ op: 6, d: { token: options.botToken, session_id: sessionId, seq: sequence } });
          } else {
            send({ op: 2, d: {
              token: options.botToken,
              intents: REQUIRED_INTENTS,
              properties: { os: process.platform, browser: "sofia-agent", device: "sofia-agent" },
            } });
          }
          identified = true;
          return;
        }
        if (payload.op === 11) {
          awaitingAck = false;
          if (ackTimer) clearTimeout(ackTimer);
          ackTimer = undefined;
          return;
        }
        if (payload.op === 1) {
          try { send({ op: 1, d: sequence }); } catch { finish("reconnect"); }
          return;
        }
        if (payload.op === 7) return finish("reconnect");
        if (payload.op === 9) {
          if (!payload.d) { sessionId = undefined; resumeUrl = undefined; sequence = null; }
          notify("gateway_invalid_session");
          return finish("invalid_session");
        }
        if (payload.op !== 0 || !identified) return;
        if (payload.t === "READY") {
          sessionId = typeof payload.d?.session_id === "string" ? payload.d.session_id : undefined;
          const candidate = payload.d?.resume_gateway_url;
          resumeUrl = typeof candidate === "string" && candidate.startsWith("wss://") ? candidate + "?v=10&encoding=json" : undefined;
          botUserId = typeof payload.d?.user?.id === "string" ? payload.d.user.id : undefined;
          notify("gateway_ready");
          return;
        }
        if (payload.t !== "MESSAGE_CREATE") return;
        const data = payload.d;
        const author = data?.author;
        if (!data?.guild_id || !data?.id || !data?.channel_id || !author?.id ||
            author.bot === true || data.webhook_id || author.id === botUserId ||
            typeof data.content !== "string") return;
        const attachments = Array.isArray(data.attachments) ? data.attachments.slice(0, 10).flatMap((item: any) => {
          if (!item || typeof item.id !== "string") return [];
          return [{
            id: item.id,
            ...(typeof item.filename === "string" ? { filename: item.filename.slice(0, 255) } : {}),
            ...(typeof item.content_type === "string" ? { contentType: item.content_type.slice(0, 128) } : {}),
            ...(typeof item.size === "number" && Number.isFinite(item.size) ? { sizeBytes: item.size } : {}),
            ...(typeof item.url === "string" && item.url.startsWith("https://cdn.discordapp.com/") ? { url: item.url } : {}),
          }];
        }) : [];
        const message: VerifiedDiscordMessage = {
          signatureVerified: true,
          id: String(data.id),
          channelId: String(data.channel_id),
          author: { id: String(author.id), ...(typeof author.username === "string" ? { username: author.username.slice(0, 128) } : {}), bot: false },
          content: data.content.slice(0, 20_000),
          createdAt: typeof data.timestamp === "string" ? Date.parse(data.timestamp) || Date.now() : Date.now(),
          attachments,
        };
        if (!/^\d{1,24}$/.test(message.id) || !/^\d{1,24}$/.test(message.channelId) || !/^\d{1,24}$/.test(message.author.id)) return;
        void callback?.(message).catch(() => notify("message_handler_failed"));
      });
    });
  }

  async function run(signal: AbortSignal): Promise<void> {
    let backoffMs = 1_000;
    let url = options.gatewayUrl ?? DISCORD_GATEWAY_URL;
    while (!signal.aborted && !stopped) {
      let reason: CloseReason;
      try { reason = await connectOnce(url, signal); }
      catch { notify("gateway_connect_failed"); reason = "reconnect"; }
      if (reason === "stopped" || signal.aborted || stopped) break;
      if (reason === "invalid_session") await wait(2_500 + Math.floor(Math.random() * 2_500), signal);
      else await wait(backoffMs, signal);
      if (reason === "reconnect") backoffMs = Math.min(30_000, backoffMs * 2);
      else backoffMs = 1_000;
      if (resumeUrl && sessionId) url = resumeUrl;
      else url = options.gatewayUrl ?? DISCORD_GATEWAY_URL;
    }
  }

  return {
    async start(signal, onMessage) {
      if (!stopped) return;
      stopped = false;
      callback = onMessage;
      controller = new AbortController();
      const stopFromParent = () => controller?.abort(signal.reason);
      signal.addEventListener("abort", stopFromParent, { once: true });
      if (signal.aborted) stopFromParent();
      loop = run(controller.signal).finally(() => signal.removeEventListener("abort", stopFromParent));
    },
    async sendMessage(channelId, text, replyToMessageId) {
      if (stopped || !controller || controller.signal.aborted) throw new Error("Discord Gateway transport is stopped.");
      if (!/^\d{1,24}$/.test(channelId)) throw new Error("Invalid Discord channel ID.");
      try {
        const response = await fetchImpl("https://discord.com/api/v10/channels/" + channelId + "/messages", {
          method: "POST",
          headers: { authorization: "Bot " + options.botToken, "content-type": "application/json" },
          body: JSON.stringify({
            content: text,
            ...(replyToMessageId && /^\d{1,24}$/.test(replyToMessageId)
              ? { message_reference: { message_id: replyToMessageId, fail_if_not_exists: false } }
              : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok) { notify("delivery_failed", response.status); throw new Error("Discord message delivery failed."); }
        const result: unknown = await response.json();
        if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string") throw new Error("Discord response omitted message ID.");
        return { messageId: result.id };
      } catch { throw new Error("Discord message delivery failed."); }
    },
    async stop() {
      stopped = true;
      callback = undefined;
      controller?.abort();
      try { socket?.close(); } catch { /* best effort */ }
      socket = undefined;
      await loop;
      controller = undefined;
      loop = undefined;
      sessionId = undefined;
      resumeUrl = undefined;
      sequence = null;
      botUserId = undefined;
    },
  };
}
