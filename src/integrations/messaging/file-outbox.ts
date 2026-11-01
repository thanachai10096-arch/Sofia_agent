import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink, chmod } from "node:fs/promises";
import path from "node:path";
import type { ChatPlatform } from "../chat-adapter.js";
import type { OutboundMessage } from "./types.js";

export interface MessagingOutboxRecord {
  id: string;
  platform: ChatPlatform;
  message: OutboundMessage;
  createdAt: number;
}
const SAFE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RECORD_BYTES = 128_000;

/**
 * Restart-persistent outbound spool. Files contain already-redacted message text;
 * keep the directory private (0700) and never enqueue credentials or raw provider payloads.
 * Delivery is at-least-once: a crash after provider acceptance but before markSent may
 * cause a duplicate outbound message, but never re-runs the underlying Sofia task.
 */
export class FileMessagingOutbox {
  private readonly directory: string;

  /** Stable local key used only to serialize flushes in this process. */
  getDirectoryKey(): string { return this.directory; }

  private chain: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    if (!directory.trim()) throw new Error("A messaging outbox directory is required.");
    this.directory = path.resolve(directory);
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { await chmod(this.directory, 0o700); } catch { /* platform may not support chmod */ }
  }

  private file(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error("Unsafe messaging outbox id.");
    return path.join(this.directory, id + ".json");
  }

  async enqueue(platform: ChatPlatform, message: OutboundMessage): Promise<string> {
    if (!message.conversationId || message.conversationId.length > 256 ||
        typeof message.text !== "string" || !message.text.trim() ||
        Buffer.byteLength(message.text, "utf8") > MAX_RECORD_BYTES) {
      throw new Error("Invalid messaging outbox record.");
    }
    await this.ensureDirectory();
    const entries = await readdir(this.directory);
    if (entries.filter((name) => name.endsWith(".json")).length >= 500) {
      throw new Error("Messaging outbox is full; pending messages require operator review.");
    }
    const id = randomUUID();
    const record: MessagingOutboxRecord = { id, platform, message, createdAt: Date.now() };
    const target = this.file(id);
    const temporary = target + "." + process.pid + ".tmp";
    const operation = this.chain.then(async () => {
      let handle;
      try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(JSON.stringify(record), "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, target);
      } catch {
        if (handle) await handle.close().catch(() => undefined);
        throw new Error("Messaging outbox persistence failed.");
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    });
    this.chain = operation.catch(() => undefined);
    await operation;
    return id;
  }

  async pending(): Promise<MessagingOutboxRecord[]> {
    await this.chain;
    await this.ensureDirectory();
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).sort();
    const records: MessagingOutboxRecord[] = [];
    for (const name of names.slice(0, 500)) {
      const id = name.slice(0, -5);
      if (!SAFE_ID.test(id)) continue;
      try {
        const raw = await readFile(this.file(id), "utf8");
        if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES + 2048) continue;
        const value = JSON.parse(raw) as MessagingOutboxRecord;
        if (value.id !== id || !Number.isFinite(value.createdAt) ||
            typeof value.platform !== "string" || !value.message ||
            typeof value.message.conversationId !== "string" ||
            typeof value.message.text !== "string" ||
            Buffer.byteLength(value.message.text, "utf8") > MAX_RECORD_BYTES) continue;
        records.push(value);
      } catch { /* corrupt records remain for operator inspection; never auto-delete */ }
    }
    return records;
  }

  async markSent(id: string): Promise<void> {
    await this.chain;
    try { await unlink(this.file(id)); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw new Error("Messaging outbox acknowledgement failed.");
    }
  }
}

// Prevent overlapping flushes for the same spool within one Node.js process.
// Cross-process coordination is deliberately not implied by this in-process guard.
const activeFlushes = new Set<string>();

/** Retry pending outbound messages without re-executing their original Sofia runs. */
export async function flushMessagingOutbox(
  outbox: FileMessagingOutbox,
  send: (platform: ChatPlatform, message: OutboundMessage) => Promise<boolean>,
  onFailure?: (platform: ChatPlatform) => void,
  platformFilter?: ChatPlatform,
): Promise<{ sent: number; pending: number }> {
  const key = outbox.getDirectoryKey();
  if (activeFlushes.has(key)) {
    const pending = await outbox.pending();
    return { sent: 0, pending: platformFilter ? pending.filter((item) => item.platform === platformFilter).length : pending.length };
  }
  activeFlushes.add(key);
  let sent = 0;
  try {
    for (const record of await outbox.pending()) {
      if (platformFilter && record.platform !== platformFilter) continue;
      try {
        if (await send(record.platform, record.message)) {
          await outbox.markSent(record.id);
          sent++;
        } else {
          onFailure?.(record.platform);
        }
      } catch {
        onFailure?.(record.platform);
      }
    }
    const pending = await outbox.pending();
    return { sent, pending: platformFilter ? pending.filter((item) => item.platform === platformFilter).length : pending.length };
  } finally {
    activeFlushes.delete(key);
  }
}
