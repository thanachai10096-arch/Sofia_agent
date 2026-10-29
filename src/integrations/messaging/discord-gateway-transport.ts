import type { DiscordTransport, VerifiedDiscordMessage } from "./discord.js";

interface GatewayPayload { op?: number; d?: unknown; s?: number | null; t?: string | null }
interface GatewayHello { heartbeat_interval?: number }
interface GatewayReady { session_id?: string; resume_gateway_url?: string; user?: { id?: string; username?: string } }
interface GatewayMessage {
  id?: string; channel_id?: string; guild_id?: string; channel_type?: number; content?: string; timestamp?: string;
  author?: { id?: string; username?: string; bot?: boolean };
  mentions?: Array<{ id?: string }>;
  referenced_message?: { author?: { id?: string; bot?: boolean } } | null;
  attachments?: Array<{ id?: string; filename?: string; content_type?: string; size?: number; url?: string }>;
}
export interface DiscordGatewaySocket {
  readonly readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: { data?: unknown; code?: number; reason?: string }) => void): void;
}
export type DiscordGatewaySocketFactory = (url: string) => DiscordGatewaySocket;
export interface DiscordGatewayTransportOptions {
  botToken: string;
  /** Inject a WebSocket factory for Node runtimes without a global WebSocket. */
  socketFactory?: DiscordGatewaySocketFactory;
  fetchImpl?: typeof fetch;
  onError?: (event: "gateway_connect_failed" | "gateway_disconnected" | "message_handler_failed" | "message_delivery_failed", status?: number) => void;
}
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const GATEWAY_INTENTS = 1 | (1 << 9) | (1 << 12) | (1 << 15);
const MAX_RECONNECT_DELAY_MS = 30_000;

function trustedResumeGatewayUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "wss:" || url.username || url.password ||
        (url.port !== "" && url.port !== "443") ||
        !(host === "gateway.discord.gg" || /^gateway-[a-z0-9-]+\.discord\.gg$/.test(host))) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Discord Gateway transport for normal message events. Gateway session authentication
 * is distinct from HTTP interaction signatures. Authorization remains in Sofia policy.
 */
export function createDiscordGatewayTransport(options: DiscordGatewayTransportOptions): DiscordTransport {
  if (!/^[A-Za-z0-9._-]{20,256}$/.test(options.botToken)) throw new Error("Discord bot token has an invalid format.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const globalWebSocket = (globalThis as unknown as { WebSocket?: new (target: string) => DiscordGatewaySocket }).WebSocket;
  if (!options.socketFactory && !globalWebSocket) {
    throw new Error("Discord Gateway requires a WebSocket implementation; inject socketFactory or use a runtime with global WebSocket.");
  }
  const socketFactory = options.socketFactory ?? ((url: string) => new globalWebSocket!(url));
  const channelTypeCache = new Map<string, number>();
  let running = false;
  let controller: AbortController | undefined;
  let currentSocket: DiscordGatewaySocket | undefined;
  let generation = 0;
  let sequence: number | null = null;
  let sessionId: string | undefined;
  let resumeUrl = GATEWAY_URL;
  let botId: string | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatAcked = true;
  let reconnectAttempt = 0;
  let callback: ((message: VerifiedDiscordMessage) => Promise<void>) | undefined;

  function notify(event: "gateway_connect_failed" | "gateway_disconnected" | "message_handler_failed" | "message_delivery_failed", status?: number): void {
    try { options.onError?.(event, status); } catch { /* diagnostics must not alter transport behavior */ }
  }
  function clearHeartbeat(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  function sendGateway(payload: Record<string, unknown>, socket = currentSocket): void {
    if (!socket || (socket.readyState !== undefined && socket.readyState !== 1)) return;
    socket.send(JSON.stringify(payload));
  }
  function stopSocket(socket: DiscordGatewaySocket | undefined): void {
    if (!socket) return;
    try { socket.close(1000, "Sofia transport reconnecting"); } catch { /* best effort */ }
  }
  function scheduleReconnect(expectedGeneration: number): void {
    if (!running || controller?.signal.aborted || expectedGeneration !== generation || reconnectTimer) return;
    clearHeartbeat();
    currentSocket = undefined;
    const delay = Math.min(1_000 * (2 ** Math.min(reconnectAttempt, 5)), MAX_RECONNECT_DELAY_MS);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (running && !controller?.signal.aborted) connect();
    }, delay);
  }
  function identifyOrResume(socket: DiscordGatewaySocket): void {
    if (sessionId && sequence !== null) {
      sendGateway({ op: 6, d: { token: options.botToken, session_id: sessionId, seq: sequence } }, socket);
      return;
    }
    sendGateway({ op: 2, d: {
      token: options.botToken, intents: GATEWAY_INTENTS,
      properties: { os: process.platform, browser: "sofia-agent", device: "sofia-agent" },
    } }, socket);
  }
  function startHeartbeat(socket: DiscordGatewaySocket, intervalMs: number): void {
    clearHeartbeat();
    if (!Number.isFinite(intervalMs) || intervalMs < 1_000 || intervalMs > 300_000) {
      notify("gateway_connect_failed");
      stopSocket(socket);
      return;
    }
    heartbeatAcked = true;
    heartbeatTimer = setInterval(() => {
      if (!running || controller?.signal.aborted || socket !== currentSocket) return;
      if (!heartbeatAcked) {
        stopSocket(socket);
        scheduleReconnect(generation);
        return;
      }
      heartbeatAcked = false;
      sendGateway({ op: 1, d: sequence }, socket);
    }, intervalMs);
    sendGateway({ op: 1, d: sequence }, socket);
    heartbeatAcked = false;
  }
  async function resolveDirectMessage(channelId: string, suppliedType?: number): Promise<boolean> {
    if (suppliedType !== undefined) {
      channelTypeCache.set(channelId, suppliedType);
      return suppliedType === 1;
    }
    const cached = channelTypeCache.get(channelId);
    if (cached !== undefined) return cached === 1;
    try {
      const response = await fetchImpl("https://discord.com/api/v10/channels/" + encodeURIComponent(channelId), {
        headers: { authorization: "Bot " + options.botToken },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) { notify("gateway_connect_failed", response.status); return false; }
      const data: unknown = await response.json();
      const type = data && typeof data === "object" && "type" in data && typeof data.type === "number" ? data.type : undefined;
      if (type !== undefined) channelTypeCache.set(channelId, type);
      return type === 1;
    } catch { return false; }
  }
  async function handleMessage(raw: GatewayMessage): Promise<void> {
    if (!callback || !raw.id || !/^\d{1,24}$/.test(raw.id) ||
        !raw.channel_id || !/^\d{1,24}$/.test(raw.channel_id) ||
        !raw.author?.id || !/^\d{1,24}$/.test(raw.author.id) || raw.author.bot === true ||
        (typeof raw.content !== "string" && !(raw.attachments?.length))) return;
    const directMessage = raw.guild_id ? false : await resolveDirectMessage(raw.channel_id, raw.channel_type);
    const mentioned = Boolean(botId && raw.mentions?.some((mention) => mention.id === botId));
    const repliedToBot = Boolean(botId && raw.referenced_message?.author?.bot === true &&
      raw.referenced_message.author.id === botId);
    const event: VerifiedDiscordMessage = {
      transportVerified: true,
      id: raw.id, channelId: raw.channel_id,
      author: { id: raw.author.id, ...(raw.author.username ? { username: raw.author.username } : {}) },
      content: raw.content ?? "",
      createdAt: typeof raw.timestamp === "string" && Number.isFinite(Date.parse(raw.timestamp)) ? Date.parse(raw.timestamp) : Date.now(),
      directMessage,
      ...(!directMessage && (mentioned || repliedToBot) ? { addressedToBot: true } : {}),
      attachments: (raw.attachments ?? []).flatMap((attachment) => {
        if (!attachment.id) return [];
        return [{
          id: attachment.id,
          ...(attachment.filename ? { filename: attachment.filename } : {}),
          ...(attachment.content_type ? { contentType: attachment.content_type } : {}),
          ...(typeof attachment.size === "number" ? { sizeBytes: attachment.size } : {}),
          ...(attachment.url ? { url: attachment.url } : {}),
        }];
      }),
    };
    try { await callback(event); } catch { notify("message_handler_failed"); }
  }
  function gatewayTargetUrl(): string {
    try {
      const target = new URL(resumeUrl || GATEWAY_URL);
      target.searchParams.set("v", "10");
      target.searchParams.set("encoding", "json");
      return target.toString();
    } catch {
      return GATEWAY_URL;
    }
  }
  function connect(): void {
    if (!running || controller?.signal.aborted) return;
    const myGeneration = ++generation;
    let socket: DiscordGatewaySocket;
    try { socket = socketFactory(gatewayTargetUrl()); }
    catch { notify("gateway_connect_failed"); scheduleReconnect(myGeneration); return; }
    currentSocket = socket;
    socket.addEventListener("message", (event) => {
      if (socket !== currentSocket || myGeneration !== generation) return;
      let payload: GatewayPayload;
      try { payload = JSON.parse(String(event.data ?? "")) as GatewayPayload; }
      catch { notify("gateway_connect_failed"); stopSocket(socket); scheduleReconnect(myGeneration); return; }
      if (typeof payload.s === "number") sequence = payload.s;
      if (payload.op === 10) {
        const hello = payload.d as GatewayHello | undefined;
        if (typeof hello?.heartbeat_interval === "number") startHeartbeat(socket, hello.heartbeat_interval);
        identifyOrResume(socket);
        return;
      }
      if (payload.op === 11) { heartbeatAcked = true; return; }
      if (payload.op === 7) { stopSocket(socket); scheduleReconnect(myGeneration); return; }
      if (payload.op === 9) {
        if (payload.d !== true) { sessionId = undefined; sequence = null; }
        stopSocket(socket); scheduleReconnect(myGeneration); return;
      }
      if (payload.op !== 0 || typeof payload.t !== "string") return;
      if (payload.t === "READY") {
        const ready = payload.d as GatewayReady | undefined;
        if (ready?.session_id) sessionId = ready.session_id;
        const trustedResumeUrl = trustedResumeGatewayUrl(ready?.resume_gateway_url);
        if (trustedResumeUrl) resumeUrl = trustedResumeUrl;
        if (ready?.user?.id) botId = ready.user.id;
        reconnectAttempt = 0;
      } else if (payload.t === "MESSAGE_CREATE" && payload.d && typeof payload.d === "object") {
        void handleMessage(payload.d as GatewayMessage);
      }
    });
    socket.addEventListener("error", () => {
      if (socket === currentSocket && myGeneration === generation) notify("gateway_connect_failed");
    });
    socket.addEventListener("close", (event) => {
      if (socket !== currentSocket || myGeneration !== generation) return;
      clearHeartbeat();
      if (event.code === 4007 || event.code === 4009) {
        sessionId = undefined;
        sequence = null;
      }
      const fatalCodes = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
      if (typeof event.code === "number" && fatalCodes.has(event.code)) {
        notify("gateway_connect_failed", event.code);
        running = false;
        callback = undefined;
        controller?.abort();
        currentSocket = undefined;
        return;
      }
      notify("gateway_disconnected", typeof event.code === "number" ? event.code : undefined);
      scheduleReconnect(myGeneration);
    });
  }
  async function sendMessage(channelId: string, text: string, replyToMessageId?: string): Promise<{ messageId: string }> {
    if (!/^\d{1,24}$/.test(channelId)) throw new Error("Invalid Discord channel ID.");
    const activeController = controller;
    if (!running || !activeController || activeController.signal.aborted) throw new Error("Discord Gateway transport is stopped.");
    const body: Record<string, unknown> = { content: text };
    if (replyToMessageId && /^\d{1,24}$/.test(replyToMessageId)) {
      body.message_reference = { message_id: replyToMessageId, fail_if_not_exists: false };
    }
    try {
      const response = await fetchImpl("https://discord.com/api/v10/channels/" + encodeURIComponent(channelId) + "/messages", {
        method: "POST",
        headers: { authorization: "Bot " + options.botToken, "content-type": "application/json" },
        body: JSON.stringify(body), signal: activeController.signal,
      });
      if (!response.ok) { notify("message_delivery_failed", response.status); throw new Error("Discord message delivery failed."); }
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string") throw new Error("Discord response omitted message ID.");
      return { messageId: result.id };
    } catch { throw new Error("Discord message delivery failed."); }
  }
  const transport: DiscordTransport = {
    async start(signal, onMessage) {
      if (running) return;
      running = true; callback = onMessage; controller = new AbortController();
      const stopFromParent = () => { void transport.stop(); };
      signal.addEventListener("abort", stopFromParent, { once: true });
      if (signal.aborted) { await transport.stop(); return; }
      connect();
    },
    async sendMessage(channelId, text, replyToMessageId) { return sendMessage(channelId, text, replyToMessageId); },
    async stop() {
      running = false; callback = undefined; controller?.abort(); controller = undefined;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined; clearHeartbeat(); generation += 1;
      const socket = currentSocket; currentSocket = undefined; stopSocket(socket);
    },
  };
  return transport;
}
