import { createHmac, timingSafeEqual } from "node:crypto";
import type { SlackTransport, VerifiedSlackMessage } from "./slack.js";

interface SlackEnvelope {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    user?: string;
    channel?: string;
    ts?: string;
    text?: string;
    thread_ts?: string;
  };
}
export interface SlackEventsRequest {
  headers: { "x-slack-signature"?: string; "x-slack-request-timestamp"?: string };
  /** Exact bytes received over HTTP; never parse and reserialize before verification. */
  rawBody: Uint8Array;
}
export interface SlackEventsResult {
  status: 200 | 400 | 401 | 503;
  body: Record<string, unknown>;
}
export type SlackEventsTransport = SlackTransport & {
  handleRequest(input: SlackEventsRequest): Promise<SlackEventsResult>;
};
export interface SlackEventsTransportOptions {
  signingSecret: string;
  botToken: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onError?: (event: "inbound_handler_failed" | "delivery_failed", status?: number) => void;
}

function verifySlackSignature(secret: string, signature: string | undefined, timestamp: string | undefined,
  rawBody: Uint8Array, nowMs: number): boolean {
  if (!signature || !/^v0=[0-9a-f]{64}$/i.test(signature) || !timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(nowMs / 1000) - seconds) > 300) return false;
  const base = Buffer.concat([Buffer.from("v0:" + timestamp + ":"), Buffer.from(rawBody)]);
  const expected = "v0=" + createHmac("sha256", secret).update(base).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Slack Events API transport with raw-body signature verification and server-side bot token. */
export function createSlackEventsTransport(options: SlackEventsTransportOptions): SlackEventsTransport {
  if (typeof options.signingSecret !== "string" || options.signingSecret.length < 16 || options.signingSecret.length > 256) {
    throw new Error("Slack signing secret has an invalid format.");
  }
  if (typeof options.botToken !== "string" || !/^xoxb-[A-Za-z0-9-]{20,240}$/.test(options.botToken)) {
    throw new Error("Slack bot token has an invalid format.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let callback: ((message: VerifiedSlackMessage) => Promise<void>) | undefined;
  let active = false;
  let controller: AbortController | undefined;
  const seenEvents = new Map<string, number>();

  function notify(event: "inbound_handler_failed" | "delivery_failed", status?: number) {
    try { options.onError?.(event, status); } catch { /* logging must not change transport behavior */ }
  }
  const transport: SlackEventsTransport = {
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
      if (!active || !callback || controller?.signal.aborted) return { status: 503, body: { error: "Slack transport unavailable." } };
      const timestamp = input.headers["x-slack-request-timestamp"];
      if (!verifySlackSignature(options.signingSecret, input.headers["x-slack-signature"], timestamp, input.rawBody, now())) {
        return { status: 401, body: { error: "Invalid Slack request signature." } };
      }
      let envelope: SlackEnvelope;
      try { envelope = JSON.parse(Buffer.from(input.rawBody).toString("utf8")) as SlackEnvelope; }
      catch { return { status: 400, body: { error: "Invalid Slack request body." } }; }
      if (envelope.type === "url_verification") {
        return typeof envelope.challenge === "string" && envelope.challenge.length <= 2000
          ? { status: 200, body: { challenge: envelope.challenge } }
          : { status: 400, body: { error: "Invalid Slack URL verification challenge." } };
      }
      if (envelope.type !== "event_callback" || !envelope.event_id || !envelope.event) {
        return { status: 400, body: { error: "Unsupported Slack event." } };
      }
      const current = now();
      for (const [id, expires] of seenEvents) if (expires <= current) seenEvents.delete(id);
      if (seenEvents.has(envelope.event_id)) return { status: 200, body: { ok: true, duplicate: true } };
      if (seenEvents.size >= 10_000) return { status: 503, body: { error: "Slack event capacity reached." } };
      // Ignore non-message events, bot output, edits/deletes and messages without immutable IDs.
      const event = envelope.event;
      if (event.type !== "message" || event.subtype || event.bot_id || !event.user ||
          !event.channel || !event.ts || typeof event.text !== "string") {
        seenEvents.set(envelope.event_id, current + 10 * 60_000);
        return { status: 200, body: { ok: true } };
      }
      seenEvents.set(envelope.event_id, current + 10 * 60_000);
      try {
        await callback({
          signatureVerified: true,
          eventId: envelope.event_id,
          messageId: event.ts,
          channelId: event.channel,
          userId: event.user,
          text: event.text,
          createdAt: Number(event.ts) * 1000 || current,
          ...(event.thread_ts ? { threadTs: event.thread_ts } : {}),
        });
      } catch {
        notify("inbound_handler_failed");
        // Slack retries failed deliveries; keep response generic.
        return { status: 503, body: { error: "Slack event handling failed." } };
      }
      return { status: 200, body: { ok: true } };
    },
    async postMessage(channelId, text, threadTs) {
      if (!active || !controller || controller.signal.aborted) throw new Error("Slack transport is stopped.");
      try {
        const response = await fetchImpl("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: { authorization: "Bearer " + options.botToken, "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({ channel: channelId, text, ...(threadTs ? { thread_ts: threadTs } : {}) }),
          signal: controller.signal,
        });
        if (!response.ok) { notify("delivery_failed", response.status); throw new Error("Slack delivery failed."); }
        const result: unknown = await response.json();
        if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true ||
            !("ts" in result) || typeof result.ts !== "string") {
          notify("delivery_failed");
          throw new Error("Slack delivery failed.");
        }
        return { messageId: result.ts };
      } catch {
        throw new Error("Slack delivery failed.");
      }
    },
    async stop() {
      active = false;
      callback = undefined;
      controller?.abort();
      controller = undefined;
      seenEvents.clear();
    },
  };
  return transport;
}
