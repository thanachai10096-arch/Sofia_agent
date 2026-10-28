import { createHmac, timingSafeEqual } from "node:crypto";
import type { WhatsAppTransport, VerifiedWhatsAppMessage } from "./whatsapp.js";

interface WhatsAppPayload {
  entry?: Array<{ changes?: Array<{ value?: {
    metadata?: { phone_number_id?: string };
    messages?: Array<{ id?: string; from?: string; timestamp?: string; type?: string; text?: { body?: string } }>;
  } }> }>;
}
export interface WhatsAppWebhookRequest {
  method: "GET" | "POST";
  headers: { "x-hub-signature-256"?: string };
  query?: { mode?: string; verifyToken?: string; challenge?: string };
  rawBody: Uint8Array;
}
export interface WhatsAppWebhookResult {
  status: 200 | 400 | 401 | 503;
  contentType?: "application/json; charset=utf-8" | "text/plain; charset=utf-8";
  body: Record<string, unknown> | string;
}
export type WhatsAppWebhookTransport = WhatsAppTransport & {
  handleRequest(input: WhatsAppWebhookRequest): Promise<WhatsAppWebhookResult>;
};
export interface WhatsAppWebhookTransportOptions {
  appSecret: string;
  verifyToken: string;
  accessToken: string;
  phoneNumberId: string;
  graphApiVersion: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onError?: (event: "inbound_handler_failed" | "delivery_failed", status?: number) => void;
}

function constantTimeTextEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function verifySignature(secret: string, signature: string | undefined, rawBody: Uint8Array): boolean {
  if (!signature || !/^sha256=[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(Buffer.from(rawBody)).digest("hex");
  return constantTimeTextEqual(expected, signature);
}

/** Meta WhatsApp Cloud API transport with GET challenge verification and POST HMAC validation. */
export function createWhatsAppWebhookTransport(options: WhatsAppWebhookTransportOptions): WhatsAppWebhookTransport {
  if (!/^[A-Fa-f0-9]{32,128}$/.test(options.appSecret)) throw new Error("WhatsApp app secret has an invalid format.");
  if (options.verifyToken.length < 16 || options.verifyToken.length > 256) throw new Error("WhatsApp verify token has an invalid format.");
  if (options.accessToken.length < 20 || options.accessToken.length > 4096) throw new Error("WhatsApp access token has an invalid format.");
  if (!/^\d{5,32}$/.test(options.phoneNumberId)) throw new Error("WhatsApp phone number ID has an invalid format.");
  if (!/^v\d{1,3}\.\d{1,2}$/.test(options.graphApiVersion)) throw new Error("WhatsApp Graph API version must be explicit (for example v23.0).");
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let callback: ((message: VerifiedWhatsAppMessage) => Promise<void>) | undefined;
  let active = false;
  let controller: AbortController | undefined;
  const seenEvents = new Map<string, number>();

  function notify(event: "inbound_handler_failed" | "delivery_failed", status?: number) {
    try { options.onError?.(event, status); } catch { /* logger cannot alter transport behavior */ }
  }
  const transport: WhatsAppWebhookTransport = {
    async start(signal, onMessage) {
      if (active) return;
      active = true; callback = onMessage; controller = new AbortController();
      const stop = () => { controller?.abort(signal.reason); active = false; };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    },
    async handleRequest(input) {
      if (input.method === "GET") {
        const query = input.query;
        if (query?.mode !== "subscribe" || !query.verifyToken || !query.challenge ||
            !constantTimeTextEqual(query.verifyToken, options.verifyToken) ||
            query.challenge.length > 256 || /[\r\n\0]/.test(query.challenge)) {
          return { status: 401, body: { error: "Webhook verification failed." } };
        }
        return { status: 200, contentType: "text/plain; charset=utf-8", body: query.challenge };
      }
      if (!active || !callback || controller?.signal.aborted) return { status: 503, body: { error: "WhatsApp transport unavailable." } };
      if (!verifySignature(options.appSecret, input.headers["x-hub-signature-256"], input.rawBody)) {
        return { status: 401, body: { error: "Invalid WhatsApp request signature." } };
      }
      let payload: WhatsAppPayload;
      try { payload = JSON.parse(Buffer.from(input.rawBody).toString("utf8")) as WhatsAppPayload; }
      catch { return { status: 400, body: { error: "Invalid WhatsApp request body." } }; }
      if (!Array.isArray(payload.entry) || payload.entry.length > 100) return { status: 400, body: { error: "Invalid WhatsApp event list." } };
      const current = now();
      for (const [id, expires] of seenEvents) if (expires <= current) seenEvents.delete(id);
      for (const entry of payload.entry) for (const change of entry.changes ?? []) {
        const value = change.value;
        const phoneNumberId = value?.metadata?.phone_number_id;
        if (phoneNumberId !== options.phoneNumberId) continue;
        for (const message of value?.messages ?? []) {
          if (message.type !== "text" || !message.id || !message.from || !/^\d{5,20}$/.test(message.from) ||
              typeof message.text?.body !== "string") continue;
          if (seenEvents.has(message.id)) continue;
          if (seenEvents.size >= 10_000) return { status: 503, body: { error: "WhatsApp event capacity reached." } };
          seenEvents.set(message.id, current + 10 * 60_000);
          try {
            await callback({
              signatureVerified: true, messageId: message.id, phoneNumberId,
              senderPhoneId: message.from, text: message.text.body,
              createdAt: Number(message.timestamp) * 1000 || current,
            });
          } catch {
            seenEvents.delete(message.id);
            notify("inbound_handler_failed");
            return { status: 503, body: { error: "WhatsApp event handling failed." } };
          }
        }
      }
      return { status: 200, body: { ok: true } };
    },
    async sendMessage(toPhoneId, text) {
      if (!active || !controller || controller.signal.aborted) throw new Error("WhatsApp transport is stopped.");
      try {
        const response = await fetchImpl("https://graph.facebook.com/" + options.graphApiVersion + "/" +
          encodeURIComponent(options.phoneNumberId) + "/messages", {
          method: "POST",
          headers: { authorization: "Bearer " + options.accessToken, "content-type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: toPhoneId, type: "text", text: { body: text } }),
          signal: controller.signal,
        });
        if (!response.ok) { notify("delivery_failed", response.status); throw new Error("WhatsApp delivery failed."); }
        const result: unknown = await response.json();
        const messages = result && typeof result === "object" && "messages" in result && Array.isArray(result.messages)
          ? result.messages[0] as { id?: unknown } | undefined : undefined;
        return { ...(typeof messages?.id === "string" ? { messageId: messages.id } : {}) };
      } catch {
        throw new Error("WhatsApp delivery failed.");
      }
    },
    async stop() { active = false; callback = undefined; controller?.abort(); controller = undefined; seenEvents.clear(); },
  };
  return transport;
}
