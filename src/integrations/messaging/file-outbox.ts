import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink, chmod, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ChatPlatform } from "../chat-adapter.js";
import type { OutboundMessage } from "./types.js";
import { calculateMessagingRetry } from "./outbox-retry-policy.js";

export interface MessagingOutboxRecord {
  id: string;
  platform: ChatPlatform;
  message: OutboundMessage;
  createdAt: number;
  attemptCount?: number;
  lastAttemptAt?: number;
  nextAttemptAt?: number;
  lastErrorCode?: "provider_unavailable";
  /** Bounded metadata-only delivery history; never stores message text or provider errors. */
  attemptHistory?: Array<{ at: number; outcome: "failed"; code: "provider_unavailable" }>;
  state?: "pending" | "dead_letter";
}
const SAFE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RECORD_BYTES = 128_000;
const DEFAULT_LEASE_MS = 5 * 60_000;

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
  private lockDirectory(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error("Unsafe messaging outbox id.");
    return path.join(this.directory, id + ".lock");
  }

  /** Atomically claim one record across processes using an exclusive lock directory. */
  async claim(id: string, leaseMs = DEFAULT_LEASE_MS, now = Date.now()): Promise<string | undefined> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 60 * 60_000) {
      throw new Error("Invalid messaging outbox lease duration.");
    }
    await this.ensureDirectory();
    const lock = this.lockDirectory(id);
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await mkdir(lock, { mode: 0o700 });
        try {
          const handle = await open(path.join(lock, "owner.json"), "wx", 0o600);
          try {
            await handle.writeFile(JSON.stringify({ token, expiresAt: now + leaseMs }), "utf8");
            await handle.sync();
          } finally { await handle.close(); }
          return token;
        } catch {
          await rm(lock, { recursive: true, force: true });
          throw new Error("Messaging outbox lease could not be persisted.");
        }
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      }

      let expired = false;
      try {
        const owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")) as { expiresAt?: number };
        expired = typeof owner.expiresAt === "number" && Number.isFinite(owner.expiresAt) && owner.expiresAt <= now;
      } catch {
        try { expired = now - (await stat(lock)).mtimeMs >= leaseMs; } catch { continue; }
      }
      if (!expired) return undefined;
      const stale = lock + ".stale." + randomUUID();
      try {
        await rename(lock, stale);
        await rm(stale, { recursive: true, force: true });
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && ["ENOENT", "EEXIST"].includes(String(error.code)))) {
          throw new Error("Expired messaging outbox lease could not be reclaimed.");
        }
      }
    }
    return undefined;
  }

  /** A stale worker cannot acknowledge a record after another worker reclaimed its lease. */
  async markSent(id: string, token: string): Promise<boolean> {
    await this.chain;
    const lock = this.lockDirectory(id);
    try {
      const owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")) as { token?: string };
      if (owner.token !== token) return false;
      await unlink(this.file(id));
      await rm(lock, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
      throw new Error("Messaging outbox acknowledgement failed.");
    }
  }

  async recordFailure(id: string, token: string, now = Date.now()): Promise<void> {
    const lock = this.lockDirectory(id);
    try {
      const owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")) as { token?: string };
      if (owner.token !== token) return;
      const target = this.file(id);
      const record = JSON.parse(await readFile(target, "utf8")) as MessagingOutboxRecord;
      const decision = calculateMessagingRetry(record.attemptCount ?? 0, now);
      const updated: MessagingOutboxRecord = {
        ...record,
        attemptCount: decision.attemptCount,
        lastAttemptAt: now,
        nextAttemptAt: decision.nextAttemptAt,
        lastErrorCode: "provider_unavailable",
        attemptHistory: [
          ...(Array.isArray(record.attemptHistory) ? record.attemptHistory.slice(-7) : []),
          { at: now, outcome: "failed" as const, code: "provider_unavailable" as const },
        ],
        state: decision.deadLetter ? "dead_letter" : "pending",
      };
      const temporary = target + "." + process.pid + "." + randomUUID() + ".tmp";
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(updated), "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temporary, target);
    } catch {
      throw new Error("Messaging outbox retry metadata could not be persisted.");
    }
  }

  async requeue(id: string): Promise<boolean> {
    const target = this.file(id);
    try {
      await stat(this.lockDirectory(id));
      return false;
    } catch { /* no active lease */ }
    try {
      const record = JSON.parse(await readFile(target, "utf8")) as MessagingOutboxRecord;
      const updated = { ...record, attemptCount: 0, nextAttemptAt: undefined, lastErrorCode: undefined, state: "pending" as const };
      const temporary = target + "." + process.pid + "." + randomUUID() + ".tmp";
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(updated), "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, target);
      return true;
    } catch { return false; }
  }

  async releaseClaim(id: string, token: string): Promise<void> {
    const lock = this.lockDirectory(id);
    try {
      const owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")) as { token?: string };
      if (owner.token === token) await rm(lock, { recursive: true, force: true });
    } catch { /* Lease may already have expired or been reclaimed. */ }
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
        if (value.attemptHistory !== undefined &&
            (!Array.isArray(value.attemptHistory) || value.attemptHistory.length > 8 ||
             value.attemptHistory.some((entry) => !entry || !Number.isFinite(entry.at) ||
               entry.outcome !== "failed" || entry.code !== "provider_unavailable"))) continue;
        records.push(value);
      } catch { /* corrupt records remain for operator inspection; never auto-delete */ }
    }
    return records;
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
  now: () => number = Date.now,
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
      if (record.state === "dead_letter" || (record.nextAttemptAt !== undefined && record.nextAttemptAt > now())) continue;
      const lease = await outbox.claim(record.id);
      if (!lease) continue;
      try {
        if (await send(record.platform, record.message)) {
          if (await outbox.markSent(record.id, lease)) sent++;
        } else {
          await outbox.recordFailure(record.id, lease, now());
          await outbox.releaseClaim(record.id, lease);
          onFailure?.(record.platform);
        }
      } catch {
        await outbox.recordFailure(record.id, lease, now()).catch(() => undefined);
        await outbox.releaseClaim(record.id, lease);
        onFailure?.(record.platform);
      }
    }
    const pending = await outbox.pending();
    return { sent, pending: platformFilter ? pending.filter((item) => item.platform === platformFilter).length : pending.length };
  } finally {
    activeFlushes.delete(key);
  }
}
