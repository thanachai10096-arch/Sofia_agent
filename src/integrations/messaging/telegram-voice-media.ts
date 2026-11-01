export interface TelegramVoiceMediaConfig {
  token: string;
  fetchImpl?: typeof fetch;
  maxDownloadBytes?: number;
  maxUploadBytes?: number;
}

export interface TelegramVoiceFile {
  bytes: Uint8Array;
  mimeType: string;
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  oga: "audio/ogg",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  webm: "audio/webm",
  flac: "audio/flac",
};

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 * 1024 * 1024) {
    throw new Error(name + " must be an integer between 1 and 52428800.");
  }
  return limit;
}

function validateToken(token: string): void {
  if (typeof token !== "string" || !/^[A-Za-z0-9:_-]{20,256}$/.test(token)) {
    throw new Error("Telegram bot token has an invalid format.");
  }
}

function safeTelegramFilePath(value: string): { path: string; mimeType: string } {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || value.startsWith("/") || value.includes("\\") || /[%?#\r\n\0]/.test(value)) {
    throw new Error("Telegram returned an invalid file path.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]{1,128}$/.test(segment))) {
    throw new Error("Telegram returned an invalid file path.");
  }
  const extension = segments[segments.length - 1]!.split(".").pop()!.toLowerCase();
  const mimeType = MIME_BY_EXTENSION[extension];
  if (!mimeType) throw new Error("Telegram voice file type is not supported.");
  return { path: segments.join("/"), mimeType };
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Telegram voice file exceeds configured byte limit.");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Telegram voice file exceeds configured byte limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Safe, opt-in Telegram Bot API media operations for voice integrations.
 * It never accepts a caller-supplied download URL: file paths are obtained
 * from getFile and fetched only from Telegram's fixed HTTPS file origin.
 */
export function createTelegramVoiceMediaClient(config: TelegramVoiceMediaConfig) {
  validateToken(config.token);
  const fetcher = config.fetchImpl ?? fetch;
  const maxDownloadBytes = positiveLimit(config.maxDownloadBytes, 10 * 1024 * 1024, "maxDownloadBytes");
  const maxUploadBytes = positiveLimit(config.maxUploadBytes, 10 * 1024 * 1024, "maxUploadBytes");
  const apiBase = "https://api.telegram.org/bot" + config.token;

  return {
    async downloadVoice(fileId: string, signal: AbortSignal): Promise<TelegramVoiceFile> {
      if (typeof fileId !== "string" || !fileId.trim() || fileId.length > 512 || /[\r\n\0]/.test(fileId)) {
        throw new Error("Telegram file ID is invalid.");
      }
      signal.throwIfAborted();
      const metadataResponse = await fetcher(apiBase + "/getFile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file_id: fileId }),
        signal,
        redirect: "error",
      });
      if (!metadataResponse.ok) throw new Error("Telegram getFile request failed with HTTP " + metadataResponse.status + ".");
      let metadata: unknown;
      try { metadata = await metadataResponse.json(); } catch { throw new Error("Telegram getFile response was invalid."); }
      const result = metadata && typeof metadata === "object" ? (metadata as { ok?: unknown; result?: unknown }) : {};
      const file = result.result && typeof result.result === "object"
        ? result.result as { file_path?: unknown; file_size?: unknown } : {};
      if (result.ok !== true || typeof file.file_path !== "string") throw new Error("Telegram getFile response omitted file path.");
      if (typeof file.file_size === "number" && (!Number.isSafeInteger(file.file_size) || file.file_size < 0 || file.file_size > maxDownloadBytes)) {
        throw new Error("Telegram voice file exceeds configured byte limit.");
      }
      const safe = safeTelegramFilePath(file.file_path);
      const url = "https://api.telegram.org/file/bot" + config.token + "/" + safe.path;
      const response = await fetcher(url, { method: "GET", signal, redirect: "error" });
      if (!response.ok) throw new Error("Telegram file download failed with HTTP " + response.status + ".");
      const bytes = await readBounded(response, maxDownloadBytes);
      if (bytes.byteLength === 0) throw new Error("Telegram returned an empty voice file.");
      return { bytes, mimeType: safe.mimeType };
    },

    async sendVoice(chatId: string, audio: TelegramVoiceFile, signal: AbortSignal): Promise<void> {
      if (typeof chatId !== "string" || !/^-?\d{1,20}$/.test(chatId)) throw new Error("Telegram chat ID is invalid.");
      if (!audio || !(audio.bytes instanceof Uint8Array) || audio.bytes.byteLength === 0 || audio.bytes.byteLength > maxUploadBytes) {
        throw new Error("Telegram voice upload is empty or exceeds configured byte limit.");
      }
      const extension = Object.entries(MIME_BY_EXTENSION).find(([, mime]) => mime === audio.mimeType)?.[0];
      if (!extension) throw new Error("Telegram voice MIME type is not supported.");
      signal.throwIfAborted();
      const form = new FormData();
      form.set("chat_id", chatId);
      form.set("voice", new Blob([audio.bytes], { type: audio.mimeType }), "sofia-voice." + extension);
      const response = await fetcher(apiBase + "/sendVoice", {
        method: "POST",
        body: form,
        signal,
        redirect: "error",
      });
      if (!response.ok) throw new Error("Telegram voice delivery failed with HTTP " + response.status + ".");
      let data: unknown;
      try { data = await response.json(); } catch { throw new Error("Telegram voice delivery response was invalid."); }
      if (!data || typeof data !== "object" || (data as { ok?: unknown }).ok !== true) {
        throw new Error("Telegram voice delivery was not accepted.");
      }
    },
  };
}
