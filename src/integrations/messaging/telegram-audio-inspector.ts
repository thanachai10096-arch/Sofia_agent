import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Sandbox } from "../../sandbox.js";

export interface TelegramAudioInspection {
  mimeType: string;
  durationMs: number;
}

export interface SandboxedTelegramAudioInspectorOptions {
  /** Must be Sofia's Docker-backed ContainerSandbox with a digest-pinned image containing ffprobe. */
  sandbox: Sandbox;
  maxInputBytes?: number;
  maxDurationMs?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * Inspects untrusted Telegram audio in a dedicated temporary workspace using
 * the existing container sandbox. The temporary mount contains only the input
 * audio; network is disabled and the container's normal resource limits apply.
 *
 * The configured immutable sandbox image must include ffprobe. This class
 * intentionally refuses ProcessSandbox and PolicySandbox.
 */
export function createSandboxedTelegramAudioInspector(
  options: SandboxedTelegramAudioInspectorOptions,
) {
  if (options.sandbox.isolation !== "container") {
    throw new Error("Telegram audio inspection requires ContainerSandbox isolation");
  }
  const maxInputBytes = options.maxInputBytes ?? 10 * 1024 * 1024;
  const maxDurationMs = options.maxDurationMs ?? 120_000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  for (const [name, value, max] of [
    ["maxInputBytes", maxInputBytes, 50 * 1024 * 1024],
    ["maxDurationMs", maxDurationMs, 600_000],
    ["timeoutMs", timeoutMs, 30_000],
    ["maxOutputBytes", maxOutputBytes, 256 * 1024],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
      throw new Error(name + " is outside its permitted range");
    }
  }

  return {
    async inspect(input: {
      bytes: Uint8Array;
      declaredMimeType?: string;
      signal: AbortSignal;
    }): Promise<TelegramAudioInspection> {
      input.signal.throwIfAborted();
      if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > maxInputBytes) {
        throw new Error("Telegram audio input exceeds configured byte limits");
      }

      // A unique, isolated directory prevents the decoder from seeing the user's
      // broader workspace or unrelated files through the container bind mount.
      const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "sofia-telegram-audio-"));
      try {
        await writeFile(path.join(workspaceRoot, "input.audio"), input.bytes, { flag: "wx", mode: 0o600 });
        const result = await options.sandbox.run(
          "ffprobe",
          [
            "-v", "error",
            "-probesize", "5M",
            "-analyzeduration", "5000000",
            "-show_entries", "format=duration,format_name:stream=codec_type",
            "-of", "json",
            "/workspace/input.audio",
          ],
          {
            workspaceRoot,
            timeoutMs,
            maxOutputBytes,
            allowNetwork: false,
          },
          input.signal,
        );
        if (result.code !== 0) throw new Error("Telegram audio decoder rejected the media");
        let parsed: unknown;
        try { parsed = JSON.parse(result.stdout); }
        catch { throw new Error("Telegram audio decoder returned invalid metadata"); }

        if (!parsed || typeof parsed !== "object") throw new Error("Telegram audio decoder returned invalid metadata");
        const metadata = parsed as {
          format?: { duration?: unknown; format_name?: unknown };
          streams?: Array<{ codec_type?: unknown }>;
        };
        const durationSeconds = Number(metadata.format?.duration);
        const formatNames = typeof metadata.format?.format_name === "string"
          ? metadata.format.format_name.toLowerCase().split(",")
          : [];
        if (!Array.isArray(metadata.streams) || !metadata.streams.some((stream) => stream?.codec_type === "audio")) {
          throw new Error("Telegram media contains no audio stream");
        }
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
          throw new Error("Telegram audio duration could not be verified");
        }
        const durationMs = Math.ceil(durationSeconds * 1000);
        if (!Number.isSafeInteger(durationMs) || durationMs > maxDurationMs) {
          throw new Error("Telegram audio duration exceeds configured limit");
        }

        const mimeType =
          formatNames.some((name) => ["wav", "wave"].includes(name)) ? "audio/wav" :
          formatNames.some((name) => ["mp3", "mp2", "mp1"].includes(name)) ? "audio/mpeg" :
          formatNames.some((name) => ["ogg", "oga"].includes(name)) ? "audio/ogg" :
          formatNames.some((name) => ["webm"].includes(name)) ? "audio/webm" :
          formatNames.some((name) => ["flac"].includes(name)) ? "audio/flac" :
          formatNames.some((name) => ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"].includes(name)) ? "audio/mp4" :
          formatNames.some((name) => ["aac"].includes(name)) ? "audio/aac" :
          undefined;
        if (!mimeType) throw new Error("Telegram audio container format is not supported");
        return { mimeType, durationMs };
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    },
  };
}
