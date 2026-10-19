import type { TelegramTransport, TelegramUpdate } from "./telegram.js";

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export interface TelegramHttpTransportOptions {
  token: string;
  fetchImpl?: typeof fetch;
  pollTimeoutSeconds?: number;
  onError?: (event: "poll_failed" | "update_failed" | "delivery_failed", status?: number) => void;
}

/**
 * Telegram Bot API transport using long polling and the built-in fetch API.
 * It never logs the bot token or provider response body. Configure a webhook
 * instead of long polling if the deployment requires inbound HTTP callbacks.
 */
export function createTelegramHttpTransport(options: TelegramHttpTransportOptions): TelegramTransport {
  const token = options.token;
  if (!/^[A-Za-z0-9:_-]{20,256}$/.test(token)) {
    throw new Error("Telegram bot token has an invalid format.");
  }
  const pollTimeoutSeconds = options.pollTimeoutSeconds ?? 25;
  if (!Number.isSafeInteger(pollTimeoutSeconds) || pollTimeoutSeconds < 1 || pollTimeoutSeconds > 50) {
    throw new Error("Telegram poll timeout must be an integer between 1 and 50 seconds.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `https://api.telegram.org/bot${token}`;
  let controller: AbortController | undefined;
  let loop: Promise<void> | undefined;
  let stopped = true;

  async function request<T>(method: string, body: Record<string, unknown> | undefined, signal: AbortSignal): Promise<T> {
    const response = await fetchImpl(`${endpoint}/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    let data: TelegramApiResponse<T>;
    try {
      data = await response.json() as TelegramApiResponse<T>;
    } catch {
      throw new Error("Telegram API returned invalid JSON.");
    }
    if (!response.ok || data.ok !== true || data.result === undefined) {
      const error = new Error("Telegram API request failed.");
      Object.assign(error, { status: response.status });
      throw error;
    }
    return data.result;
  }

  async function wait(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
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

  async function poll(signal: AbortSignal, onUpdate: (update: TelegramUpdate) => Promise<void>): Promise<void> {
    let offset: number | undefined;
    let backoffMs = 1_000;
    while (!signal.aborted && !stopped) {
      try {
        const updates = await request<TelegramUpdate[]>("getUpdates", {
          timeout: pollTimeoutSeconds,
          allowed_updates: ["message"],
          ...(offset === undefined ? {} : { offset }),
        }, signal);
        for (const update of updates) {
          if (signal.aborted || stopped) break;
          // A single malformed/poison update must not prevent later updates in
          // the same batch from being handled. Report only a safe event name;
          // never log message content, credentials, or provider response text.
          try {
            await onUpdate(update);
          } catch {
            try { options.onError?.("update_failed"); } catch { /* diagnostics must not stop polling */ }
          } finally {
            // Advance past every safely identified update even when its handler
            // fails, otherwise Telegram will redeliver it and can starve the queue.
            if (Number.isSafeInteger(update.update_id)) offset = update.update_id + 1;
          }
        }
        backoffMs = 1_000;
      } catch (error) {
        if (signal.aborted || stopped) break;
        const status = error && typeof error === "object" && "status" in error && typeof error.status === "number"
          ? error.status : undefined;
        try { options.onError?.("poll_failed", status); } catch { /* logging must not terminate polling */ }
        await wait(backoffMs, signal);
        backoffMs = Math.min(30_000, backoffMs * 2);
      }
    }
  }

  return {
    async start(signal, onUpdate) {
      if (!stopped) return;
      stopped = false;
      controller = new AbortController();
      const stopFromParent = () => controller?.abort(signal.reason);
      signal.addEventListener("abort", stopFromParent, { once: true });
      if (signal.aborted) stopFromParent();
      // This runtime uses long polling, so remove any stale Telegram webhook
      // configuration before getUpdates. Preserve queued updates.
      if (!controller.signal.aborted) {
        try {
          await request<boolean>("deleteWebhook", { drop_pending_updates: false }, controller.signal);
        } catch {
          // Do not log token or provider response bodies. Polling will emit a
          // safe status-only diagnostic if Telegram still rejects getUpdates.
        }
      }
      if (controller.signal.aborted) {
        signal.removeEventListener("abort", stopFromParent);
        return;
      }
      loop = poll(controller.signal, onUpdate).finally(() => {
        signal.removeEventListener("abort", stopFromParent);
      });
      // Return after launching the loop; the polling promise is joined by stop().
    },
    async sendMessage(chatId, text, replyToMessageId) {
      if (stopped) throw new Error("Telegram transport is stopped.");
      const activeController = controller;
      if (!activeController || activeController.signal.aborted) throw new Error("Telegram transport is stopped.");
      try {
        const result = await request<{ message_id: number }>("sendMessage", {
          chat_id: chatId,
          text,
          ...(replyToMessageId && /^\d+$/.test(replyToMessageId)
            ? { reply_parameters: { message_id: Number(replyToMessageId) } }
            : {}),
        }, activeController.signal);
        if (!Number.isSafeInteger(result.message_id)) throw new Error("Telegram response omitted message ID.");
        return { messageId: String(result.message_id) };
      } catch {
        try { options.onError?.("delivery_failed"); } catch { /* logging must not mask the delivery error */ }
        throw new Error("Telegram message delivery failed.");
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      controller?.abort();
      await loop?.catch(() => undefined);
      controller = undefined;
      loop = undefined;
    },
  };
}
