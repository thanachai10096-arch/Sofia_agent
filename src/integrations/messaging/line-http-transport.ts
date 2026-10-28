import { createHmac, timingSafeEqual } from "node:crypto";
import type { LineTransport, VerifiedLineMessage } from "./line.js";

interface LineWebhookEnvelope {
  events?: Array<{
    type?: string;
    webhookEventId?: string;
    timestamp?: number;
    source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
    message?: { id?: string; type?: string; text?: string };
  }>;
}
export interface LineHttpTransportOptions {
  channelAccessToken: string;
  channelSecret: string;
  fetchImpl?: typeof fetch;
  /** Host webhook route must pass the exact unmodified request body here. */
  onWarning?: (event: "line_signature_rejected" | "line_payload_rejected" | "line_delivery_failed") => void;
}
export interface LineWebhookResult {
  status: 200 | 400 | 401 | 413 | 503;
  acceptedEvents: number;
}

/** Verify LINE's base64 HMAC-SHA256 signature against the exact raw request bytes. */
export function verifyLineSignature(input: {
  channelSecret: string | undefined;
  signature: string | undefined;
  rawBody: Uint8Array;
}): boolean {
  const { channelSecret, signature, rawBody } = input;
  if (!channelSecret || channelSecret.length > 512 || !signature ||
      !/^[A-Za-z0-9+/]{43}=$/.test(signature) || rawBody.byteLength > 1_000_000) return false;
  const expected = createHmac("sha256", channelSecret).update(Buffer.from(rawBody)).digest();
  let received: Buffer;
  try { received = Buffer.from(signature, "base64"); } catch { return false; }
  return received.length === expected.length && timingSafeEqual(received, expected) &&
    received.toString("base64") === signature;
}

/**
 * LINE Messaging API transport. The host must mount a raw-body webhook route and
 * call handleWebhook; no framework-specific server or route is created here.
 */
export function createLineHttpTransport(options: LineHttpTransportOptions): LineTransport & {
  handleWebhook(rawBody: Uint8Array, signature: string | undefined): Promise<LineWebhookResult>;
} {
  const token = options.channelAccessToken.trim();
  const secret = options.channelSecret.trim();
  if (!token || token.length > 4096 || /[\r\n]/.test(token)) throw new Error("LINE channel access token is invalid.");
  if (!secret || secret.length > 512 || /[\r\n]/.test(secret)) throw new Error("LINE channel secret is invalid.");
  const fetchImpl = options.fetchImpl ?? fetch;
  let callback: ((message: VerifiedLineMessage) => Promise<void>) | undefined;
  let stopped = true;
  let activeSignal: AbortSignal | undefined;

  async function request(path: string, body: unknown, signal?: AbortSignal): Promise<{ messageId?: string }> {
    const response = await fetchImpl("https://api.line.me/v2/bot/" + path, {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      try { options.onWarning?.("line_delivery_failed"); } catch { /* diagnostics must not break transport */ }
      throw new Error("LINE API request failed.");
    }
    let payload: { sentMessages?: Array<{ id?: string }> } = {};
    try { payload = await response.json() as typeof payload; } catch { /* success may have no JSON body */ }
    return { ...(payload.sentMessages?.[0]?.id ? { messageId: payload.sentMessages[0].id } : {}) };
  }

  return {
    async start(signal, onMessage) {
      if (!stopped) return;
      stopped = false;
      activeSignal = signal;
      callback = onMessage;
      if (signal.aborted) { stopped = true; callback = undefined; return; }
      signal.addEventListener("abort", () => {
        stopped = true;
        callback = undefined;
      }, { once: true });
    },
    async handleWebhook(rawBody, signature) {
      if (stopped || !callback || activeSignal?.aborted) return { status: 503, acceptedEvents: 0 };
      if (rawBody.byteLength > 1_000_000) return { status: 413, acceptedEvents: 0 };
      if (!verifyLineSignature({ channelSecret: secret, signature, rawBody })) {
        try { options.onWarning?.("line_signature_rejected"); } catch { /* ignore diagnostic failures */ }
        return { status: 401, acceptedEvents: 0 };
      }
      let envelope: LineWebhookEnvelope;
      try { envelope = JSON.parse(Buffer.from(rawBody).toString("utf8")) as LineWebhookEnvelope; }
      catch {
        try { options.onWarning?.("line_payload_rejected"); } catch { /* ignore diagnostic failures */ }
        return { status: 400, acceptedEvents: 0 };
      }
      if (!Array.isArray(envelope.events) || envelope.events.length > 100) {
        try { options.onWarning?.("line_payload_rejected"); } catch { /* ignore diagnostic failures */ }
        return { status: 400, acceptedEvents: 0 };
      }
      let acceptedEvents = 0;
      for (const event of envelope.events) {
        if (stopped || activeSignal?.aborted) return { status: 503, acceptedEvents };
        if (event.type !== "message" || event.message?.type !== "text" ||
            typeof event.message.text !== "string" || !event.message.id ||
            !event.webhookEventId || !event.source?.userId || !Number.isSafeInteger(event.timestamp)) continue;
        const conversationId = event.source.groupId || event.source.roomId || event.source.userId;
        if (!conversationId || event.message.text.length > 100_000) continue;
        try {
          await callback({
            signatureVerified: true,
            webhookEventId: event.webhookEventId,
            messageId: event.message.id,
            userId: event.source.userId,
            conversationId,
            text: event.message.text,
            timestamp: event.timestamp!,
          });
          acceptedEvents++;
        } catch {
          // Do not expose message content, credentials, or provider response bodies.
          try { options.onWarning?.("line_payload_rejected"); } catch { /* diagnostics must not break webhook processing */ }
        }
      }
      return { status: 200, acceptedEvents };
    },
    async pushMessage(conversationId, text) {
      if (stopped || activeSignal?.aborted) throw new Error("LINE transport is stopped.");
      if (!conversationId || conversationId.length > 256 || !text || text.length > 5_000) {
        throw new Error("LINE outbound message is invalid.");
      }
      return request("message/push", {
        to: conversationId,
        messages: [{ type: "text", text }],
      }, activeSignal);
    },
    async stop() {
      stopped = true;
      callback = undefined;
      activeSignal = undefined;
    },
  };
}
