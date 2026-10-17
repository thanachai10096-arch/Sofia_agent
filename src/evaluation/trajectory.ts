import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, writeSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { redactSecrets } from "../security/guard.js";

export interface TrajectoryEvent {
  runId: string;
  sequence: number;
  timestamp: string;
  type: string;
  data: unknown;
}
export interface TrajectoryRecorderOptions {
  file: string;
  maxEventBytes?: number;
  maxStringLength?: number;
}

function bounded(value: unknown, maxStringLength: number, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") return value.length > maxStringLength ? value.slice(0, maxStringLength) + "[TRUNCATED]" : value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => bounded(item, maxStringLength, depth + 1));
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 100);
    const result: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      result[key] = /(?:token|secret|password|credential|private.?key|authorization|api.?key)/i.test(key)
        ? "[REDACTED]"
        : bounded(item, maxStringLength, depth + 1);
    }
    return result;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (typeof value === "bigint") return value.toString();
  return value;
}

/**
 * Append-only JSONL trajectory recorder. Use only for explicitly configured offline
 * evaluation. It redacts secret-shaped data, bounds payload size, and never records
 * raw task prompts automatically.
 */
export class TrajectoryRecorder {
  private readonly file: string;
  private readonly maxEventBytes: number;
  private readonly maxStringLength: number;
  private readonly runId = randomUUID();
  private sequence = 0;

  constructor(options: TrajectoryRecorderOptions) {
    if (!path.isAbsolute(options.file)) throw new Error("Trajectory output path must be absolute");
    this.file = options.file;
    this.maxEventBytes = options.maxEventBytes ?? 64 * 1024;
    this.maxStringLength = options.maxStringLength ?? 4_000;
    if (!Number.isSafeInteger(this.maxEventBytes) || this.maxEventBytes < 1_024 || this.maxEventBytes > 1_048_576) {
      throw new Error("maxEventBytes must be between 1024 and 1048576");
    }
    if (!Number.isSafeInteger(this.maxStringLength) || this.maxStringLength < 64 || this.maxStringLength > 100_000) {
      throw new Error("maxStringLength must be between 64 and 100000");
    }
  }

  record(type: string, data: unknown): TrajectoryEvent {
    if (!type.trim() || type.length > 200) throw new Error("Trajectory event type must be non-empty and at most 200 characters");
    const safeData = bounded(redactSecrets(data), this.maxStringLength);
    const event: TrajectoryEvent = {
      runId: this.runId,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      type,
      data: safeData,
    };
    const line = JSON.stringify(event) + "\n";
    if (Buffer.byteLength(line, "utf8") > this.maxEventBytes) {
      this.sequence--;
      throw new Error("Trajectory event exceeds configured maxEventBytes");
    }
    const directory = path.dirname(this.file);
    mkdirSync(directory, { recursive: true });
    if (existsSync(this.file) && lstatSync(this.file).isSymbolicLink()) {
      this.sequence--;
      throw new Error("Trajectory output must not be a symbolic link");
    }
    const fd = openSync(this.file, "a", 0o600);
    try {
      writeSync(fd, line, undefined, "utf8");
      chmodSync(this.file, 0o600);
    } catch (error) {
      this.sequence--;
      throw error;
    } finally {
      closeSync(fd);
    }
    return event;
  }
}
