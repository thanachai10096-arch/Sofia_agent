import { createHmac, timingSafeEqual } from "node:crypto";
import type { LineTransport, VerifiedLineMessage } from "./line.js";

interface LineEvent {
  type?: string;
  webhookEventId?: string;
  timestamp?: number;
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
  message?: { id?: string; type?: string; text?: string };
}
interface LineWebhookBody { events?: LineEvent[]; }
export interface LineWebhookRequest {
  headers: { "x-line-signature"?: string };
  /** Exact raw request bytes; LINE signature verification must happen before JSON parsing. */
  rawBody: Uint8Array;
}
export interface LineWebhookResult {
  status: 200 | 400 | 401 | 503;
  body: Record<string, unknown>;
}
export type LineWebhookTransport = LineTransport & {
  handleRequest(input: LineWebhookRequest): Promise<LineWebhookResult>;
};
export interface LineWebhookTransportOptions {
  channelSecret: string;
  channelAccessToken: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onError?: (event: "inbound_handler_failed" | "delivery_failed", status?: number) => void;
}

function verifyLineSignature(secret: string, signature: string | undefined, rawBody: Uint8Array): boolean {
  if (!signature || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(Buffer.from(rawBody)).digest();
  const supplied = Buffer.from(signature, "base64");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** LINE Messaging API webhook transport with raw-body HMAC verification and push delivery. */
export function createLineWebhookTransport(options: LineWebhookTransportOptions): LineWebhookTransport {
  if (typeof options.channelSecret !== "string" || options.channelSecret.length < 16 || options.channelSecret.length > 256) {
    throw new Error("LINE channel secret has an invalid format.");
  }
  if (typeof options.channelAccessToken !== "string" || options.channelAccessToken.length < 20 || options.channelAccessToken.length > 4096) {
    throw new Error("LINE channel access token has an invalid format.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let callback: ((message: VerifiedLineMessage) => Promise<void>) | undefined;
  let active = false;
  let controller: AbortController | undefined;
  const seenEvents = new Map<string, number>();

  function notify(event: "inbound_handler_failed" | "delivery_failed", status?: number) {
    try { options.onError?.(event, status); } catch { /* logging cannot change transport behavior */ }
  }
  const transport: LineWebhookTransport = {
    async start(signal, onMessage) {
      if (active) return;
      active = true;
      callback = onMessage;
      controller = new AbortController();
      const stop = () => { controller?.abort(signal.reason); active = false; };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    },
    async handleRequest(input) {
      if (!active || !callback || controller?.signal.aborted) return { status: 503, body: { error: "LINE transport unavailable." } };
      if (!verifyLineSignature(options.channelSecret, input.headers["x-line-signature"], input.rawBody)) {
        return { status: 401, body: { error: "Invalid LINE request signature." } };
      }
      let payload: LineWebhookBody;
      try { payload = JSON.parse(Buffer.from(input.rawBody).toString("utf8")) as LineWebhookBody; }
      catch { return { status: 400, body: { error: "Invalid LINE request body." } }; }
      if (!Array.isArray(payload.events) || payload.events.length > 100) {
        return { status: 400, body: { error: "Invalid LINE event list." } };
      }
      const current = now();
      for (const [id, expires] of seenEvents) if (expires <= current) seenEvents.delete(id);
      for (const event of payload.events) {
        if (event.type !== "message" || event.message?.type !== "text") continue;
        const eventId = event.webhookEventId;
        const messageId = event.message.id;
        const userId = event.source?.userId;
        const conversationId = event.source?.groupId ?? event.source?.roomId ?? userId;
        if (!eventId || !messageId || !userId || !conversationId || typeof event.message.text !== "string") continue;
        if (seenEvents.has(eventId)) continue;
        if (seenEvents.size >= 10_000) return { status: 503, body: { error: "LINE event capacity reached." } };
        seenEvents.set(eventId, current + 10 * 60_000);
        try {
          await callback({
            signatureVerified: true, eventId, messageId, userId, conversationId,
            text: event.message.text, createdAt: Number.isFinite(event.timestamp) ? event.timestamp! : current,
          });
        } catch {
          seenEvents.delete(eventId);
          notify("inbound_handler_failed");
          return { status: 503, body: { error: "LINE event handling failed." } };
        }
      }
      return { status: 200, body: { ok: true } };
    },
    async pushMessage(to, text) {
      if (!active || !controller || controller.signal.aborted) throw new Error("LINE transport is stopped.");
      try {
        const response = await fetchImpl("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: { authorization: "Bearer " + options.channelAccessToken, "content-type": "application/json" },
          body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
          signal: controller.signal,
        });
        if (!response.ok) { notify("delivery_failed", response.status); throw new Error("LINE delivery failed."); }
        const result: unknown = await response.json().catch(() => ({}));
        const sent = result && typeof result === "object" && "sentMessages" in result && Array.isArray(result.sentMessages)
          ? result.sentMessages[0] as { id?: unknown } | undefined : undefined;
        return { ...(typeof sent?.id === "string" ? { messageId: sent.id } : {}) };
      } catch {
        throw new Error("LINE delivery failed.");
      }
    },
    async stop() {
      active = false; callback = undefined; controller?.abort(); controller = undefined; seenEvents.clear();
    },
  };
  return transport;
}
