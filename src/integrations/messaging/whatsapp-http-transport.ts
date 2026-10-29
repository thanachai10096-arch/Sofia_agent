import { createHmac, timingSafeEqual } from "node:crypto";
import type { WhatsAppTransport, VerifiedWhatsAppMessage } from "./whatsapp.js";

interface WhatsAppEnvelope {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: Array<{
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
        }>;
      };
    }>;
  }>;
}
export interface WhatsAppHttpTransportOptions {
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  phoneNumberId: string;
  graphApiVersion: string;
  fetchImpl?: typeof fetch;
  onWarning?: (event: "whatsapp_signature_rejected" | "whatsapp_payload_rejected" | "whatsapp_delivery_failed") => void;
}
export interface WhatsAppWebhookResult {
  status: 200 | 400 | 401 | 413 | 503;
  acceptedEvents: number;
}

/** Verify Meta X-Hub-Signature-256 against exact raw request bytes. */
export function verifyWhatsAppSignature(input: {
  appSecret: string | undefined;
  signature: string | undefined;
  rawBody: Uint8Array;
}): boolean {
  const { appSecret, signature, rawBody } = input;
  if (!appSecret || appSecret.length > 512 || !signature ||
      !/^sha256=[a-f0-9]{64}$/i.test(signature) || rawBody.byteLength > 1_000_000) return false;
  const expected = createHmac("sha256", appSecret).update(Buffer.from(rawBody)).digest();
  const received = Buffer.from(signature.slice("sha256=".length), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Constant-time token comparison for Meta's initial GET webhook challenge. */
export function verifyWhatsAppWebhookChallenge(input: {
  mode: string | undefined;
  token: string | undefined;
  challenge: string | undefined;
  verifyToken: string;
}): string | undefined {
  const { mode, token, challenge, verifyToken } = input;
  if (mode !== "subscribe" || !token || !challenge || !verifyToken ||
      token.length > 512 || challenge.length > 2048 || verifyToken.length > 512) return undefined;
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  return challenge;
}

/** Server-side WhatsApp Cloud API transport; provider credentials are never exposed to adapters. */
export function createWhatsAppHttpTransport(options: WhatsAppHttpTransportOptions): WhatsAppTransport & {
  handleWebhook(rawBody: Uint8Array, signature: string | undefined): Promise<WhatsAppWebhookResult>;
  verifyChallenge(input: { mode: string | undefined; token: string | undefined; challenge: string | undefined }): string | undefined;
} {
  const accessToken = options.accessToken.trim();
  const appSecret = options.appSecret.trim();
  const verifyToken = options.verifyToken.trim();
  const phoneNumberId = options.phoneNumberId.trim();
  const version = options.graphApiVersion.trim();
  if (!accessToken || accessToken.length > 4096 || /[\r\n]/.test(accessToken)) throw new Error("WhatsApp access token is invalid.");
  if (!appSecret || appSecret.length > 512 || /[\r\n]/.test(appSecret)) throw new Error("WhatsApp app secret is invalid.");
  if (!verifyToken || verifyToken.length > 512 || /[\r\n]/.test(verifyToken)) throw new Error("WhatsApp verify token is invalid.");
  if (!/^[0-9]{5,32}$/.test(phoneNumberId)) throw new Error("WhatsApp phone number ID is invalid.");
  if (!/^v[0-9]+\.[0-9]+$/.test(version)) throw new Error("WhatsApp Graph API version must be explicit, e.g. vXX.0.");
  const fetchImpl = options.fetchImpl ?? fetch;
  let callback: ((message: VerifiedWhatsAppMessage) => Promise<void>) | undefined;
  let activeSignal: AbortSignal | undefined;
  let stopped = true;

  async function request(path: string, body: unknown, signal?: AbortSignal): Promise<{ messageId?: string }> {
    const response = await fetchImpl("https://graph.facebook.com/" + version + "/" + path, {
      method: "POST",
      headers: { authorization: "Bearer " + accessToken, "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      try { options.onWarning?.("whatsapp_delivery_failed"); } catch { /* diagnostics must not break transport */ }
      throw new Error("WhatsApp API request failed.");
    }
    let payload: { messages?: Array<{ id?: string }> } = {};
    try { payload = await response.json() as typeof payload; } catch { /* tolerate an empty success response */ }
    return { ...(payload.messages?.[0]?.id ? { messageId: payload.messages[0].id } : {}) };
  }

  return {
    async start(signal, onMessage) {
      if (!stopped) return;
      stopped = false;
      activeSignal = signal;
      callback = onMessage;
      if (signal.aborted) { stopped = true; callback = undefined; return; }
      signal.addEventListener("abort", () => { stopped = true; callback = undefined; }, { once: true });
    },
    verifyChallenge(input) {
      return verifyWhatsAppWebhookChallenge({ ...input, verifyToken });
    },
    async handleWebhook(rawBody, signature) {
      if (stopped || !callback || activeSignal?.aborted) return { status: 503, acceptedEvents: 0 };
      if (rawBody.byteLength > 1_000_000) return { status: 413, acceptedEvents: 0 };
      if (!verifyWhatsAppSignature({ appSecret, signature, rawBody })) {
        try { options.onWarning?.("whatsapp_signature_rejected"); } catch { /* ignore diagnostic failures */ }
        return { status: 401, acceptedEvents: 0 };
      }
      let envelope: WhatsAppEnvelope;
      try { envelope = JSON.parse(Buffer.from(rawBody).toString("utf8")) as WhatsAppEnvelope; }
      catch {
        try { options.onWarning?.("whatsapp_payload_rejected"); } catch { /* ignore diagnostic failures */ }
        return { status: 400, acceptedEvents: 0 };
      }
      if (envelope.object !== "whatsapp_business_account" || !Array.isArray(envelope.entry) || envelope.entry.length > 100) {
        try { options.onWarning?.("whatsapp_payload_rejected"); } catch { /* ignore diagnostic failures */ }
        return { status: 400, acceptedEvents: 0 };
      }
      let acceptedEvents = 0;
      let failed = false;
      for (const entry of envelope.entry) {
        for (const change of entry.changes ?? []) {
          if (change.field !== "messages" || !change.value || !Array.isArray(change.value.messages)) continue;
          const businessPhoneId = change.value.metadata?.phone_number_id;
          if (businessPhoneId !== phoneNumberId) continue;
          for (const message of change.value.messages) {
            if (stopped || activeSignal?.aborted) return { status: 503, acceptedEvents };
            if (message.type !== "text" || !message.id || !message.from || !message.timestamp ||
                !message.text || typeof message.text.body !== "string" || message.text.body.length > 100_000 ||
                !/^[0-9]{1,32}$/.test(message.from) || !/^[0-9]{1,16}$/.test(message.timestamp)) continue;
            const timestamp = Number(message.timestamp) * 1000;
            if (!Number.isSafeInteger(timestamp) || timestamp <= 0) continue;
            try {
              await callback({
                signatureVerified: true,
                eventId: entry.id || businessPhoneId,
                messageId: message.id,
                userId: message.from,
                phoneNumberId: businessPhoneId,
                text: message.text.body,
                timestamp,
              });
              acceptedEvents++;
            } catch {
              failed = true;
              try { options.onWarning?.("whatsapp_payload_rejected"); } catch { /* diagnostics must not break webhook processing */ }
            }
          }
        }
      }
      return { status: failed ? 503 : 200, acceptedEvents };
    },
    async sendText(recipientId, text) {
      if (stopped || activeSignal?.aborted) throw new Error("WhatsApp transport is stopped.");
      if (!/^[0-9]{1,32}$/.test(recipientId) || !text || text.length > 4_096) {
        throw new Error("WhatsApp outbound message is invalid.");
      }
      return request(phoneNumberId + "/messages", {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipientId,
        type: "text",
        text: { preview_url: false, body: text },
      }, activeSignal);
    },
    async stop() { stopped = true; callback = undefined; activeSignal = undefined; },
  };
}
