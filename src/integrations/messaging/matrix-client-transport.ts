import { randomUUID } from "node:crypto";
import type { MatrixTransport, VerifiedMatrixMessage } from "./matrix.js";

interface MatrixEvent {
  event_id?: string;
  sender?: string;
  origin_server_ts?: number;
  type?: string;
  content?: { msgtype?: string; body?: string };
}
interface MatrixSyncResponse {
  next_batch?: string;
  rooms?: { join?: Record<string, { timeline?: { events?: MatrixEvent[] } }> };
}
export interface MatrixClientTransportOptions {
  homeserverUrl: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  onError?: (event: "sync_failed" | "delivery_failed", status?: number) => void;
  syncTimeoutMs?: number;
}
function validateHomeserver(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Matrix homeserver URL is invalid."); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      (url.pathname !== "/" && url.pathname !== "") || host === "localhost" ||
      host.endsWith(".localhost") || host.endsWith(".local") ||
      /^127\./.test(host) || /^10\./.test(host) || /^0\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === "::1" || host.startsWith("[")) {
    throw new Error("Matrix homeserver must be a public HTTPS origin.");
  }
  return new URL(url.origin);
}

/** Matrix Client-Server API polling transport. Access tokens never leave server-side requests. */
export function createMatrixClientTransport(options: MatrixClientTransportOptions): MatrixTransport {
  const homeserver = validateHomeserver(options.homeserverUrl);
  if (!options.accessToken || options.accessToken.length > 4096 || /[\r\n\0]/.test(options.accessToken)) {
    throw new Error("Matrix access token has an invalid format.");
  }
  const syncTimeoutMs = options.syncTimeoutMs ?? 25_000;
  if (!Number.isSafeInteger(syncTimeoutMs) || syncTimeoutMs < 1_000 || syncTimeoutMs > 30_000) {
    throw new Error("Matrix sync timeout must be between 1000 and 30000 milliseconds.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  let controller: AbortController | undefined;
  let callback: ((message: VerifiedMatrixMessage) => Promise<void>) | undefined;
  let active = false;
  let syncTask: Promise<void> | undefined;
  let since: string | undefined;
  let firstSyncComplete = false;
  let ownUserId: string | undefined;
  const seen = new Map<string, number>();

  function notify(event: "sync_failed" | "delivery_failed", status?: number) {
    try { options.onError?.(event, status); } catch { /* diagnostics cannot break transport */ }
  }
  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, homeserver);
    const headers = new Headers(init.headers);
    headers.set("authorization", "Bearer " + options.accessToken);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      headers,
      signal: controller?.signal,
    });
    return response;
  }
  async function syncLoop(): Promise<void> {
    while (active && controller && !controller.signal.aborted) {
      try {
        const query = new URLSearchParams({ timeout: String(syncTimeoutMs), ...(since ? { since } : {}) });
        const response = await request("/_matrix/client/v3/sync?" + query.toString());
        if (!response.ok) { notify("sync_failed", response.status); await new Promise(resolve => setTimeout(resolve, 1_000)); continue; }
        const payload: unknown = await response.json();
        if (!payload || typeof payload !== "object") { notify("sync_failed"); continue; }
        const result = payload as MatrixSyncResponse;
        if (typeof result.next_batch !== "string" || !result.next_batch) {
          notify("sync_failed");
          await new Promise(resolve => setTimeout(resolve, 1_000));
          continue;
        }
        since = result.next_batch;
        // The first sync establishes a cursor. Do not replay timeline history as new user input.
        if (!firstSyncComplete) {
          firstSyncComplete = true;
          continue;
        }
        const joined = result.rooms?.join ?? {};
        const now = Date.now();
        for (const [eventId, expires] of seen) if (expires <= now) seen.delete(eventId);
        for (const [roomId, room] of Object.entries(joined)) {
          for (const event of room.timeline?.events ?? []) {
            if (event.type !== "m.room.message" || !event.event_id || !event.sender ||
                event.sender === ownUserId || typeof event.content?.body !== "string" ||
                event.content.msgtype !== "m.text" || event.content.body.length > 100_000) continue;
            if (seen.has(event.event_id)) continue;
            if (seen.size >= 10_000) { notify("sync_failed"); break; }
            seen.set(event.event_id, now + 10 * 60_000);
            try {
              await callback?.({
                authenticated: true,
                eventId: event.event_id,
                roomId,
                senderId: event.sender,
                text: event.content.body,
                createdAt: Number.isFinite(event.origin_server_ts) ? event.origin_server_ts! : now,
              });
            } catch {
              seen.delete(event.event_id);
              notify("sync_failed");
            }
          }
        }
      } catch {
        if (controller?.signal.aborted) break;
        notify("sync_failed");
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
    }
  }
  return {
    async start(signal, onMessage) {
      if (active) return;
      controller = new AbortController();
      const stop = () => { active = false; controller?.abort(signal.reason); };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) { stop(); return; }
      callback = onMessage;
      try {
        const response = await request("/_matrix/client/v3/account/whoami");
        if (!response.ok) throw new Error("Matrix authentication failed.");
        const payload: unknown = await response.json();
        if (!payload || typeof payload !== "object" || !("user_id" in payload) ||
            typeof payload.user_id !== "string" || !payload.user_id.startsWith("@")) {
          throw new Error("Matrix whoami response is invalid.");
        }
        ownUserId = payload.user_id;
        active = true;
        syncTask = syncLoop();
        void syncTask.catch(() => notify("sync_failed"));
      } catch {
        active = false;
        controller.abort();
        callback = undefined;
        throw new Error("Matrix transport could not authenticate with the homeserver.");
      }
    },
    async sendMessage(roomId, text) {
      if (!active || !controller || controller.signal.aborted) throw new Error("Matrix transport is stopped.");
      if (!roomId.startsWith("!") || roomId.length > 255 || /[\r\n\0]/.test(roomId)) {
        throw new Error("Matrix room ID is invalid.");
      }
      try {
        const txnId = randomUUID();
        const path = "/_matrix/client/v3/rooms/" + encodeURIComponent(roomId) +
          "/send/m.room.message/" + encodeURIComponent(txnId);
        const response = await request(path, {
          method: "PUT",
          body: JSON.stringify({ msgtype: "m.text", body: text }),
        });
        if (!response.ok) { notify("delivery_failed", response.status); throw new Error("Matrix delivery failed."); }
        const result: unknown = await response.json();
        if (!result || typeof result !== "object" || !("event_id" in result) ||
            typeof result.event_id !== "string") throw new Error("Matrix delivery response is invalid.");
        return { messageId: result.event_id };
      } catch {
        notify("delivery_failed");
        throw new Error("Matrix delivery failed.");
      }
    },
    async stop() {
      active = false;
      controller?.abort();
      if (syncTask) await Promise.race([syncTask, new Promise(resolve => setTimeout(resolve, 1_500))]);
      callback = undefined;
      controller = undefined;
      syncTask = undefined;
      since = undefined;
      firstSyncComplete = false;
      ownUserId = undefined;
      seen.clear();
    },
  };
}
