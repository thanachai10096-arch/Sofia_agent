import type { TelegramPollLeaseRedisClient } from "./telegram-poll-lease.js";

interface UpstashRestResponse {
  result?: unknown;
  error?: string;
}

/**
 * Minimal Upstash Redis REST adapter for the Telegram poll lease.
 *
 * Uses the documented JSON command-array API so SET NX PX and Lua EVAL are
 * executed atomically by Redis without adding a TCP client dependency.
 */
export class UpstashTelegramPollLeaseClient implements TelegramPollLeaseRedisClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: {
    url: string;
    token: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) {
    let parsed: URL;
    try {
      parsed = new URL(options.url);
    } catch {
      throw new Error("Telegram poll lease REST URL is invalid.");
    }
    const localHttp = parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if ((parsed.protocol !== "https:" && !localHttp) ||
        parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("Telegram poll lease REST URL must use HTTPS without embedded credentials or query parameters.");
    }
    const token = options.token.trim();
    if (!token || token.length > 4096) {
      throw new Error("Telegram poll lease REST token is invalid.");
    }
    const timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30_000) {
      throw new Error("Telegram poll lease REST timeout must be between 500 and 30000 milliseconds.");
    }
    this.endpoint = parsed.origin + parsed.pathname.replace(/\/+$/, "");
    this.token = token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = timeoutMs;
  }

  private async command(command: Array<string | number>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authorization: "Bearer " + this.token,
          "content-type": "application/json",
        },
        body: JSON.stringify(command),
        signal: controller.signal,
      });
      let payload: UpstashRestResponse;
      try {
        payload = await response.json() as UpstashRestResponse;
      } catch {
        throw new Error("Telegram poll lease REST response was not valid JSON.");
      }
      if (!response.ok || typeof payload.error === "string") {
        throw new Error("Telegram poll lease Redis command failed.");
      }
      return payload.result;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Telegram poll lease")) throw error;
      throw new Error("Telegram poll lease Redis request failed.");
    } finally {
      clearTimeout(timer);
    }
  }

  async set(
    key: string,
    value: string,
    options: { NX: true; PX: number },
  ): Promise<string | null> {
    const result = await this.command(["SET", key, value, "NX", "PX", options.PX]);
    return typeof result === "string" ? result : null;
  }

  async eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown> {
    return this.command([
      "EVAL",
      script,
      options.keys.length,
      ...options.keys,
      ...options.arguments,
    ]);
  }
}
