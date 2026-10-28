import type { DiscordTransport, VerifiedDiscordMessage } from "./discord.js";

interface GatewayPayload {
  op?: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}
interface GatewayHello { heartbeat_interval?: number; }
interface GatewayReady { session_id?: string; resume_gateway_url?: string; }
interface GatewayMessage {
  id?: string;
  channel_id?: string;
  content?: string;
  timestamp?: string;
  guild_id?: string;
  author?: { id?: string; username?: string; bot?: boolean };
  attachments?: Array<{ id?: string; filename?: string; content_type?: string; size?: number; url?: string }>;
}
interface SocketEvent { data?: unknown; code?: number; reason?: string; }
export interface DiscordGatewaySocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: SocketEvent) => void): void;
  removeEventListener(type: "open" | "message" | "close" | "error", listener: (event: SocketEvent) => void): void;
}
export interface DiscordGatewayTransportOptions {
  botToken: string;
  /** Explicit user/channel allowlists are checked before a message reaches the shared gateway. */
  allowedUserIds?: string[];
  allowedChannelIds?: string[];
  fetchImpl?: typeof fetch;
  /** Injectable for tests or runtimes with a WebSocket implementation. Defaults to the runtime WebSocket. */
  webSocketFactory?: (url: string) => DiscordGatewaySocket;
  onError?: (event: "gateway_failed" | "delivery_failed", status?: number) => void;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;
const INTENTS_GUILDS = 1 << 0;
const INTENTS_GUILD_MESSAGES = 1 << 9;
const INTENTS_MESSAGE_CONTENT = 1 << 15;
const OPEN = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function snowflake(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,24}$/.test(value);
}
function safeNotify(options: DiscordGatewayTransportOptions, event: "gateway_failed" | "delivery_failed", status?: number): void {
  try { options.onError?.(event, status); } catch { /* diagnostics must not break transport */ }
}
async function eventText(data: unknown): Promise<string | undefined> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (typeof Blob !== "undefined" && data instanceof Blob) return await data.text();
  return undefined;
}

/**
 * Discord Gateway transport for ordinary MESSAGE_CREATE events. It feeds the
 * existing Discord adapter/MessagingGateway; it does not run Sofia itself.
 *
 * Requires the Discord Message Content privileged intent to be enabled for the
 * bot in the Developer Portal. Gateway authentication is token/session based;
 * the interaction HTTP transport remains responsible for Ed25519 signatures.
 */
export function createDiscordGatewayTransport(options: DiscordGatewayTransportOptions): DiscordTransport {
  if (!/^[A-Za-z0-9._-]{20,256}$/.test(options.botToken)) throw new Error("Discord bot token has an invalid format.");
  const reconnectBaseMs = options.reconnectBaseMs ?? 1_000;
  const reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
  if (!Number.isSafeInteger(reconnectBaseMs) || reconnectBaseMs < 100 || reconnectBaseMs > 60_000 ||
      !Number.isSafeInteger(reconnectMaxMs) || reconnectMaxMs < reconnectBaseMs || reconnectMaxMs > 300_000) {
    throw new Error("Invalid Discord Gateway reconnect configuration.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const socketFactory = options.webSocketFactory ?? ((url: string) => {
    const Constructor = globalThis.WebSocket;
    if (typeof Constructor !== "function") throw new Error("This runtime does not provide WebSocket; supply webSocketFactory.");
    return new Constructor(url) as unknown as DiscordGatewaySocket;
  });

  let active = false;
  let callback: ((message: VerifiedDiscordMessage) => Promise<void>) | undefined;
  let controller: AbortController | undefined;
  let loop: Promise<void> | undefined;
  let socket: DiscordGatewaySocket | undefined;
  let sessionId: string | undefined;
  let resumeUrl: string | undefined;
  let sequence: number | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatInterval = 0;
  let awaitingHeartbeatAck = false;
  let firstReadyResolve: (() => void) | undefined;
  let firstReadyReject: ((error: Error) => void) | undefined;
  let firstReadySettled = false;

  function settleFirstReady(error?: Error): void {
    if (firstReadySettled) return;
    firstReadySettled = true;
    if (error) firstReadyReject?.(error);
    else firstReadyResolve?.();
  }
  function clearHeartbeat(): void {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
    heartbeatInterval = 0;
    awaitingHeartbeatAck = false;
  }
  function sendPayload(payload: GatewayPayload): void {
    if (!socket || socket.readyState !== OPEN) throw new Error("Discord Gateway socket is not open.");
    socket.send(JSON.stringify(payload));
  }
  function sendHeartbeat(): void {
    if (!socket || socket.readyState !== OPEN || controller?.signal.aborted) return;
    if (awaitingHeartbeatAck) {
      socket.close(4000, "Heartbeat ACK timeout");
      return;
    }
    try {
      sendPayload({ op: OP_HEARTBEAT, d: sequence ?? null });
      awaitingHeartbeatAck = true;
    } catch {
      socket.close(4000, "Heartbeat send failed");
      return;
    }
    heartbeatTimer = setTimeout(sendHeartbeat, heartbeatInterval);
  }
  function scheduleHeartbeat(interval: number): void {
    clearHeartbeat();
    heartbeatInterval = interval;
    // Discord recommends a random initial delay to avoid synchronized heartbeats.
    heartbeatTimer = setTimeout(sendHeartbeat, Math.floor(Math.random() * interval));
  }
  function identifyOrResume(): void {
    if (sessionId && sequence !== undefined) {
      sendPayload({ op: OP_RESUME, d: { token: options.botToken, session_id: sessionId, seq: sequence } });
      return;
    }
    sendPayload({ op: OP_IDENTIFY, d: {
      token: options.botToken,
      intents: INTENTS_GUILDS | INTENTS_GUILD_MESSAGES | INTENTS_MESSAGE_CONTENT,
      properties: { os: process.platform, browser: "sofia-agent", device: "sofia-agent" },
    } });
  }

  async function handleDispatch(payload: GatewayPayload): Promise<void> {
    if (typeof payload.s === "number" && Number.isSafeInteger(payload.s)) sequence = payload.s;
    if (payload.t === "READY" && isRecord(payload.d)) {
      const ready = payload.d as GatewayReady;
      if (typeof ready.session_id === "string") sessionId = ready.session_id;
      if (typeof ready.resume_gateway_url === "string" && /^wss:\/\//i.test(ready.resume_gateway_url)) {
        resumeUrl = ready.resume_gateway_url.replace(/\/$/, "") + "/?v=10&encoding=json";
      }
      settleFirstReady();
      return;
    }
    if (payload.t === "RESUMED") { settleFirstReady(); return; }
    if (payload.t !== "MESSAGE_CREATE" || !isRecord(payload.d)) return;
    const raw = payload.d as GatewayMessage;
    if (!snowflake(raw.id) || !snowflake(raw.channel_id) || !raw.author || !snowflake(raw.author.id) ||
        raw.author.bot || typeof raw.content !== "string") return;
    if (options.allowedUserIds && (!options.allowedUserIds.length || !options.allowedUserIds.includes(raw.author.id))) return;
    if (options.allowedChannelIds && (!options.allowedChannelIds.length || !options.allowedChannelIds.includes(raw.channel_id))) return;
    const createdAt = typeof raw.timestamp === "string" ? Date.parse(raw.timestamp) : Date.now();
    const event: VerifiedDiscordMessage = {
      signatureVerified: true,
      id: raw.id,
      channelId: raw.channel_id,
      author: { id: raw.author.id, ...(raw.author.username ? { username: raw.author.username } : {}), bot: false },
      content: raw.content,
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      attachments: (raw.attachments ?? []).filter((item) => snowflake(item.id)).slice(0, 20).map((item) => ({
        id: item.id!,
        ...(typeof item.filename === "string" ? { filename: item.filename.slice(0, 256) } : {}),
        ...(typeof item.content_type === "string" ? { contentType: item.content_type.slice(0, 128) } : {}),
        ...(typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size >= 0 ? { sizeBytes: item.size } : {}),
        ...(typeof item.url === "string" ? { url: item.url.slice(0, 2_000) } : {}),
      })),
    };
    try { await callback?.(event); } catch { safeNotify(options, "gateway_failed"); }
  }

  async function connectOnce(signal: AbortSignal): Promise<void> {
    const url = resumeUrl ?? GATEWAY_URL;
    const current = socketFactory(url);
    socket = current;
    await new Promise<void>((resolve) => {
      let opened = false;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearHeartbeat();
        current.removeEventListener("open", onOpen);
        current.removeEventListener("message", onMessage);
        current.removeEventListener("close", onClose);
        current.removeEventListener("error", onError);
        signal.removeEventListener("abort", onAbort);
        if (socket === current) socket = undefined;
        resolve();
      };
      const onOpen = () => { opened = true; };
      const onClose = () => { finish(); };
      const onError = () => { if (!opened) settleFirstReady(new Error("Discord Gateway connection failed.")); };
      const onAbort = () => { try { current.close(1000, "Sofia transport stopped"); } finally { finish(); } };
      const onMessage = (event: SocketEvent) => {
        void (async () => {
          const text = await eventText(event.data);
          if (!text) return;
          let payload: GatewayPayload;
          try { payload = JSON.parse(text) as GatewayPayload; } catch { return; }
          if (typeof payload.op !== "number") return;
          if (payload.op === OP_HELLO && isRecord(payload.d)) {
            const interval = (payload.d as GatewayHello).heartbeat_interval;
            if (!Number.isSafeInteger(interval) || typeof interval !== "number" || interval < 1_000 || interval > 300_000) {
              current.close(4002, "Invalid heartbeat interval");
              return;
            }
            scheduleHeartbeat(interval);
            try { identifyOrResume(); } catch { current.close(4000, "Identify failed"); }
          } else if (payload.op === OP_HEARTBEAT) {
            try { sendPayload({ op: OP_HEARTBEAT, d: sequence ?? null }); } catch { current.close(4000, "Heartbeat failed"); }
          } else if (payload.op === OP_HEARTBEAT_ACK) {
            awaitingHeartbeatAck = false;
          } else if (payload.op === OP_RECONNECT) {
            current.close(4000, "Gateway requested reconnect");
          } else if (payload.op === OP_INVALID_SESSION) {
            if (payload.d !== true) { sessionId = undefined; sequence = undefined; resumeUrl = undefined; }
            current.close(4000, "Invalid Gateway session");
          } else if (payload.op === OP_DISPATCH) {
            await handleDispatch(payload);
          }
        })().catch(() => safeNotify(options, "gateway_failed"));
      };
      current.addEventListener("open", onOpen);
      current.addEventListener("message", onMessage);
      current.addEventListener("close", onClose);
      current.addEventListener("error", onError);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  async function runLoop(signal: AbortSignal): Promise<void> {
    let backoff = reconnectBaseMs;
    while (!signal.aborted && active) {
      try {
        await connectOnce(signal);
      } catch {
        safeNotify(options, "gateway_failed");
      }
      if (signal.aborted || !active) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, backoff);
        function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
      backoff = Math.min(reconnectMaxMs, backoff * 2);
    }
  }

  return {
    async start(signal, onMessage) {
      if (active) return;
      active = true;
      callback = onMessage;
      controller = new AbortController();
      const stopFromParent = () => controller?.abort(signal.reason);
      signal.addEventListener("abort", stopFromParent, { once: true });
      if (signal.aborted) stopFromParent();
      loop = runLoop(controller.signal).finally(() => signal.removeEventListener("abort", stopFromParent));
      await new Promise<void>((resolve, reject) => {
        firstReadyResolve = resolve;
        firstReadyReject = reject;
        if (controller?.signal.aborted) settleFirstReady(new Error("Discord Gateway transport stopped before ready."));
        const timeout = setTimeout(() => settleFirstReady(new Error("Discord Gateway did not become ready in time.")), 30_000);
        const originalResolve = firstReadyResolve;
        const originalReject = firstReadyReject;
        firstReadyResolve = () => { clearTimeout(timeout); originalResolve?.(); };
        firstReadyReject = (error) => { clearTimeout(timeout); originalReject?.(error); };
      }).catch(async (error) => {
        await this.stop();
        throw error;
      });
    },
    async sendMessage(channelId, text, replyToMessageId) {
      if (!active || controller?.signal.aborted) throw new Error("Discord Gateway transport is stopped.");
      if (!snowflake(channelId)) throw new Error("Invalid Discord channel ID.");
      try {
        const response = await fetchImpl(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: "POST",
          headers: { authorization: `Bot ${options.botToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            content: text,
            ...(replyToMessageId && snowflake(replyToMessageId)
              ? { message_reference: { message_id: replyToMessageId, fail_if_not_exists: false } }
              : {}),
          }),
          signal: controller?.signal,
        });
        if (!response.ok) {
          safeNotify(options, "delivery_failed", response.status);
          throw new Error("Discord message delivery failed.");
        }
        const result: unknown = await response.json();
        if (!isRecord(result) || !snowflake(result.id)) throw new Error("Discord response omitted message ID.");
        return { messageId: result.id };
      } catch {
        throw new Error("Discord message delivery failed.");
      }
    },
    async stop() {
      active = false;
      callback = undefined;
      controller?.abort();
      try { socket?.close(1000, "Sofia transport stopped"); } catch { /* best effort */ }
      clearHeartbeat();
      if (loop) await loop;
      loop = undefined;
      controller = undefined;
      sessionId = undefined;
      resumeUrl = undefined;
      sequence = undefined;
    },
  };
}
