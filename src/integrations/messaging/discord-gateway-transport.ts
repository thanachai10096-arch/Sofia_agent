import type { DiscordTransport, VerifiedDiscordMessage } from "./discord.js";

interface GatewayPayload {
  op?: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}
interface GatewayReady {
  session_id?: string;
  resume_gateway_url?: string;
}
interface GatewayMessage {
  id?: string;
  channel_id?: string;
  content?: string;
  timestamp?: string;
  author?: { id?: string; username?: string; bot?: boolean };
  attachments?: Array<{ id?: string; filename?: string; content_type?: string; size?: number; url?: string }>;
}

/** Minimal event surface shared by ws and deterministic test doubles. */
export interface DiscordGatewaySocket {
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "close", listener: (code: number, reason?: unknown) => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export interface DiscordGatewayTransportOptions {
  botToken: string;
  allowedUserIds: string[];
  allowedChannelIds: string[];
  /** Inject the WebSocket implementation so protocol logic stays independently testable. */
  createSocket: (url: string) => DiscordGatewaySocket;
  gatewayUrl?: string;
  fetchImpl?: typeof fetch;
  random?: () => number;
  onError?: (event: "gateway_error" | "inbound_handler_failed" | "delivery_failed", status?: number) => void;
}
const GATEWAY_VERSION = 10;
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);
const SNOWFLAKE = /^\d{1,24}$/;
const MAX_DEDUPE_IDS = 2_000;

function parsePayload(data: unknown): GatewayPayload | undefined {
  try {
    const raw = typeof data === "string"
      ? data
      : data instanceof ArrayBuffer
        ? new TextDecoder().decode(data)
        : ArrayBuffer.isView(data)
          ? new TextDecoder().decode(data)
          : data && typeof data === "object" && "toString" in data
            ? String(data)
            : "";
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !("op" in parsed) ||
        typeof (parsed as { op?: unknown }).op !== "number") return undefined;
    return parsed as GatewayPayload;
  } catch {
    return undefined;
  }
}
function isDiscordGatewayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "wss:" && (url.hostname === "discord.gg" || url.hostname.endsWith(".discord.gg")) && !url.username && !url.password;
  } catch { return false; }
}
function timestampMillis(value?: string): number {
  if (!value) return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * Discord Gateway ingress. It owns only the Gateway connection; HTTP Interactions
 * remain available for slash commands. MESSAGE_CONTENT must be enabled in the
 * Discord Developer Portal before this transport can identify successfully.
 */
export function createDiscordGatewayTransport(options: DiscordGatewayTransportOptions): DiscordTransport {
  if (!/^[A-Za-z0-9._-]{20,256}$/.test(options.botToken)) throw new Error("Discord bot token has an invalid format.");
  if (!options.allowedUserIds.length || options.allowedUserIds.some((id) => !SNOWFLAKE.test(id))) {
    throw new Error("Discord Gateway requires a non-empty valid user allowlist.");
  }
  if (!options.allowedChannelIds.length || options.allowedChannelIds.some((id) => !SNOWFLAKE.test(id))) {
    throw new Error("Discord Gateway requires a non-empty valid channel allowlist.");
  }
  const allowedUsers = new Set(options.allowedUserIds);
  const allowedChannels = new Set(options.allowedChannelIds);
  const fetchImpl = options.fetchImpl ?? fetch;
  const random = options.random ?? Math.random;
  const baseUrl = options.gatewayUrl ?? "wss://gateway.discord.gg/";
  if (!isDiscordGatewayUrl(baseUrl)) throw new Error("Discord Gateway URL must use the official wss://discord.gg host.");
  let active = false;
  let parentSignal: AbortSignal | undefined;
  let socket: DiscordGatewaySocket | undefined;
  let callback: ((message: VerifiedDiscordMessage) => Promise<void>) | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatInterval = 0;
  let awaitingHeartbeatAck = false;
  let sequence: number | null = null;
  let sessionId: string | undefined;
  let resumeUrl: string | undefined;
  let reconnectAttempt = 0;
  let generation = 0;
  const seenIds = new Set<string>();

  function notify(event: "gateway_error" | "inbound_handler_failed" | "delivery_failed", status?: number): void {
    try { options.onError?.(event, status); } catch { /* telemetry must not change transport state */ }
  }
  function clearHeartbeat(): void {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
    heartbeatInterval = 0;
    awaitingHeartbeatAck = false;
  }
  function send(op: number, data: unknown): void {
    if (!socket) return;
    socket.send(JSON.stringify({ op, d: data }));
  }
  function heartbeat(): void {
    if (!active || !socket) return;
    if (awaitingHeartbeatAck) {
      try { socket.close(4000, "Heartbeat acknowledgement timeout"); } catch { /* close event reconnects */ }
      return;
    }
    awaitingHeartbeatAck = true;
    send(1, sequence);
    heartbeatTimer = setTimeout(heartbeat, heartbeatInterval);
    heartbeatTimer.unref?.();
  }
  function scheduleHeartbeat(interval: number): void {
    clearHeartbeat();
    heartbeatInterval = interval;
    const jitter = Math.max(0, Math.min(0.999999, random()));
    heartbeatTimer = setTimeout(heartbeat, Math.floor(interval * jitter));
    heartbeatTimer.unref?.();
  }
  function scheduleReconnect(resume: boolean): void {
    if (!active || reconnectTimer) return;
    if (!resume) {
      sessionId = undefined;
      resumeUrl = undefined;
      sequence = null;
    }
    const delay = Math.min(30_000, 1_000 * (2 ** Math.min(reconnectAttempt++, 5)));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
    reconnectTimer.unref?.();
  }
  function dispatchMessage(data: unknown): void {
    if (!callback || !data || typeof data !== "object") return;
    const message = data as GatewayMessage;
    const author = message.author;
    if (!message.id || !SNOWFLAKE.test(message.id) ||
        !message.channel_id || !allowedChannels.has(message.channel_id) ||
        !author?.id || !SNOWFLAKE.test(author.id) || !allowedUsers.has(author.id) ||
        author.bot === true || seenIds.has(message.id)) return;
    if (seenIds.size >= MAX_DEDUPE_IDS) {
      const oldest = seenIds.values().next().value as string | undefined;
      if (oldest) seenIds.delete(oldest);
    }
    seenIds.add(message.id);
    const event: VerifiedDiscordMessage = {
      signatureVerified: true,
      id: message.id,
      channelId: message.channel_id,
      author: { id: author.id, ...(author.username ? { username: author.username } : {}), bot: false },
      content: typeof message.content === "string" ? message.content : "",
      createdAt: timestampMillis(message.timestamp),
      attachments: (Array.isArray(message.attachments) ? message.attachments : []).flatMap((attachment) => {
        if (!attachment || typeof attachment.id !== "string") return [];
        return [{
          id: attachment.id,
          ...(typeof attachment.filename === "string" ? { filename: attachment.filename } : {}),
          ...(typeof attachment.content_type === "string" ? { contentType: attachment.content_type } : {}),
          ...(typeof attachment.size === "number" && Number.isFinite(attachment.size) ? { sizeBytes: attachment.size } : {}),
          ...(typeof attachment.url === "string" ? { url: attachment.url } : {}),
        }];
      }),
    };
    void Promise.resolve().then(() => callback?.(event)).catch(() => notify("inbound_handler_failed"));
  }
  function handlePayload(payload: GatewayPayload): void {
    if (payload.op === 0) {
      if (typeof payload.s === "number" && Number.isSafeInteger(payload.s)) sequence = payload.s;
      if (payload.t === "READY" && payload.d && typeof payload.d === "object") {
        const ready = payload.d as GatewayReady;
        if (typeof ready.session_id === "string" && ready.session_id.length <= 256 &&
            typeof ready.resume_gateway_url === "string" && isDiscordGatewayUrl(ready.resume_gateway_url)) {
          sessionId = ready.session_id;
          resumeUrl = ready.resume_gateway_url;
          reconnectAttempt = 0;
        }
      } else if (payload.t === "MESSAGE_CREATE") {
        dispatchMessage(payload.d);
      }
      return;
    }
    if (payload.op === 1) {
      if (heartbeatInterval > 0) { awaitingHeartbeatAck = true; send(1, sequence); }
      return;
    }
    if (payload.op === 7) {
      try { socket?.close(4000, "Discord requested reconnect"); } catch { scheduleReconnect(Boolean(sessionId && resumeUrl)); }
      return;
    }
    if (payload.op === 9) {
      const resumable = payload.d === true;
      if (!resumable) {
        sessionId = undefined;
        resumeUrl = undefined;
        sequence = null;
      }
      try { socket?.close(4000, "Discord invalid session"); } catch { scheduleReconnect(resumable); }
      return;
    }
    if (payload.op === 10 && payload.d && typeof payload.d === "object") {
      const interval = (payload.d as { heartbeat_interval?: unknown }).heartbeat_interval;
      if (typeof interval !== "number" || !Number.isFinite(interval) || interval < 1 || interval > 300_000) {
        try { socket?.close(4000, "Invalid heartbeat interval"); } catch { scheduleReconnect(false); }
        return;
      }
      scheduleHeartbeat(interval);
      if (sessionId && resumeUrl && sequence !== null) {
        send(6, { token: options.botToken, session_id: sessionId, seq: sequence });
      } else {
        send(2, {
          token: options.botToken,
          intents: INTENTS,
          properties: { os: process.platform, browser: "sofia-agent", device: "sofia-agent" },
        });
      }
      return;
    }
    if (payload.op === 11) {
      awaitingHeartbeatAck = false;
    }
  }
  function connect(): void {
    if (!active) return;
    const currentGeneration = ++generation;
    const endpoint = sessionId && resumeUrl ? resumeUrl : baseUrl;
    const url = new URL(endpoint);
    url.searchParams.set("v", String(GATEWAY_VERSION));
    url.searchParams.set("encoding", "json");
    let next: DiscordGatewaySocket;
    try { next = options.createSocket(url.toString()); }
    catch {
      notify("gateway_error");
      scheduleReconnect(Boolean(sessionId && resumeUrl));
      return;
    }
    socket = next;
    next.on("open", () => { if (currentGeneration !== generation) return; });
    next.on("message", (raw) => {
      if (currentGeneration !== generation) return;
      const payload = parsePayload(raw);
      if (payload) handlePayload(payload);
    });
    next.on("close", (code) => {
      if (currentGeneration !== generation) return;
      clearHeartbeat();
      socket = undefined;
      if (code === 4004 || code === 4013 || code === 4014) {
        active = false;
        notify("gateway_error");
        return;
      }
      if (code === 4007 || code === 4009) {
        scheduleReconnect(false);
      } else {
        scheduleReconnect(Boolean(sessionId && resumeUrl));
      }
    });
    next.on("error", () => notify("gateway_error"));
  }

  return {
    async start(signal, onMessage) {
      if (active) return;
      active = true;
      parentSignal = signal;
      callback = onMessage;
      const stop = () => { void this.stop(); };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) { await this.stop(); return; }
      connect();
    },
    async sendMessage(channelId, text, replyToMessageId) {
      if (!active || !SNOWFLAKE.test(channelId)) throw new Error("Discord Gateway transport is stopped or channel ID is invalid.");
      try {
        const response = await fetchImpl(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: "POST",
          headers: { authorization: `Bot ${options.botToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            content: text,
            ...(replyToMessageId && SNOWFLAKE.test(replyToMessageId)
              ? { message_reference: { message_id: replyToMessageId, fail_if_not_exists: false } }
              : {}),
          }),
          signal: parentSignal,
        });
        if (!response.ok) { notify("delivery_failed", response.status); throw new Error("Discord message delivery failed."); }
        const result: unknown = await response.json();
        if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string") {
          throw new Error("Discord response omitted message ID.");
        }
        return { messageId: result.id };
      } catch {
        throw new Error("Discord message delivery failed.");
      }
    },
    async stop() {
      if (!active && !socket) return;
      active = false;
      callback = undefined;
      generation++;
      clearHeartbeat();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      try { socket?.close(1000, "Sofia shutting down"); } catch { /* shutdown is best effort */ }
      socket = undefined;
    },
  };
}
