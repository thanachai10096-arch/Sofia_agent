import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DesktopAction } from "./types.js";
import type { DesktopCompanionStore, DesktopCompanionRecord } from "./companion-store.js";

export interface DesktopCompanionCommand {
  id: string;
  action: DesktopAction;
  createdAt: number;
}

/** Invalid or revoked companion bearer token; safe to translate to HTTP 401. */
export class DesktopCompanionAuthenticationError extends Error {
  constructor() {
    super("Desktop companion is not paired or its token was revoked.");
    this.name = "DesktopCompanionAuthenticationError";
  }
}

interface Companion {
  ownerKeyId: string;
  tokenDigest: Buffer;
  connectedAt: number;
  lastSeenAt: number;
  persistedAt: number;
}

interface CompletionReceipt {
  ownerKeyId: string;
  tokenDigest: Buffer;
  payloadDigest: Buffer;
  completedAt: number;
}

interface PendingCommand extends DesktopCompanionCommand {
  ownerKeyId: string;
  assigned: boolean;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abort?: () => void;
  signal?: AbortSignal;
}

/**
 * Async-capable broker contract for API routes. The in-memory implementation
 * remains synchronous for pairing/poll/completion; durable or remote adapters
 * may perform those operations asynchronously without changing HTTP semantics.
 */
export type MaybePromise<T> = T | Promise<T>;

export interface DesktopCommandBrokerPort {
  connect(ownerKeyId: string): MaybePromise<{ token: string; connectedAt: number }>;
  disconnect(ownerKeyId: string): MaybePromise<void>;
  poll(token: string): MaybePromise<DesktopCompanionCommand | null>;
  complete(token: string, commandId: string, result: unknown, error?: string): MaybePromise<boolean>;
  dispatch(ownerKeyId: string, action: DesktopAction, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
  getStatus(ownerKeyId: string): MaybePromise<{ connected: boolean; lastSeenAt?: number; pendingCommands: number }>;
  close(): MaybePromise<void>;
}

export interface DesktopCommandBrokerConfig {
  now?: () => number;
  commandTimeoutMs?: number;
  companionIdleTimeoutMs?: number;
  maxPendingPerOwner?: number;
  store?: DesktopCompanionStore;
}

/**
 * In-memory relay between a cloud Brain and one explicitly paired local desktop.
 * The companion authenticates with a high-entropy bearer token; only its digest is
 * retained. Commands are owner-bound, single-claim, single-completion, bounded,
 * and fail closed on disconnect, timeout, or process restart. Paired tokens\n * may remain idle for up to seven days so a locally stored OS-keychain token\n * can survive a normal desktop shutdown/restart; broker state is still lost\n * when the Sofia API process itself restarts.
 *
 * This class is transport-neutral. An API route must authenticate the Sofia API
 * key and its desktop:connect scope before calling connect/poll/complete.
 */
export class DesktopCommandBroker {
  private readonly now: () => number;
  private readonly commandTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxPending: number;
  private readonly store?: DesktopCompanionStore;
  private readonly companions = new Map<string, Companion>();
  private readonly pending = new Map<string, PendingCommand>();
  // Short-lived in-memory receipts make completion POST retries idempotent
  // without ever re-running the local desktop action.
  private readonly completionReceipts = new Map<string, CompletionReceipt>();
  private readonly completionReceiptTtlMs = 5 * 60_000;
  private readonly maxCompletionReceipts = 512;

  constructor(config: DesktopCommandBrokerConfig = {}) {
    this.now = config.now ?? Date.now;
    // Keep the relay deadline longer than the local GUI approval window (60s by default),
    // so an operator can review and approve a legitimate desktop action before it expires.
    this.commandTimeoutMs = clamp(config.commandTimeoutMs ?? 90_000, 1_000, 120_000);
    this.idleTimeoutMs = clamp(config.companionIdleTimeoutMs ?? 7 * 24 * 60 * 60 * 1_000, 5_000, 30 * 24 * 60 * 60 * 1_000);
    this.maxPending = clamp(config.maxPendingPerOwner ?? 8, 1, 64);
    this.store = config.store;
    if (this.store) {
      for (const record of this.store.loadAll()) {
        const companion: Companion = {
          ownerKeyId: record.ownerKeyId,
          tokenDigest: Buffer.from(record.tokenDigest, "hex"),
          connectedAt: record.connectedAt,
          lastSeenAt: record.lastSeenAt,
          persistedAt: record.lastSeenAt,
        };
        if (companion.lastSeenAt < this.now() - this.idleTimeoutMs) {
          this.store.delete(companion.ownerKeyId);
          continue;
        }
        this.companions.set(companion.ownerKeyId, companion);
      }
    }
  }

  /** Replace any previous companion for this owner and issue a one-time secret. */
  connect(ownerKeyId: string): { token: string; connectedAt: number } {
    assertOwner(ownerKeyId);
    // Only revoke when this process has an active pairing. A fresh owner has
    // no durable record to delete, and a no-op connect must not depend on the
    // persistence layer being writable.
    if (this.companions.has(ownerKeyId)) this.disconnect(ownerKeyId);
    const token = randomBytes(32).toString("base64url");
    const connectedAt = this.now();
    const companion: Companion = {
      ownerKeyId,
      tokenDigest: digest(token),
      connectedAt,
      lastSeenAt: connectedAt,
      persistedAt: connectedAt,
    };
    this.persist(companion);
    this.companions.set(ownerKeyId, companion);
    return { token, connectedAt };
  }

  /** Returns the next command once. Re-polling never re-delivers an assigned command. */
  poll(token: string): DesktopCompanionCommand | null {
    const companion = this.authenticate(token);
    this.touch(companion);
    const command = [...this.pending.values()].find(
      (item) => item.ownerKeyId === companion.ownerKeyId && !item.assigned,
    );
    if (!command) return null;
    command.assigned = true;
    return { id: command.id, action: command.action, createdAt: command.createdAt };
  }

  /** Complete only a command claimed by this exact companion token. */
  complete(token: string, commandId: string, result: unknown, error?: string): boolean {
    const companion = this.authenticate(token);
    this.touch(companion);
    const payloadDigest = digest(JSON.stringify({ result: result ?? null, error: error ?? null }));
    this.pruneCompletionReceipts();
    const receipt = this.completionReceipts.get(commandId);
    if (receipt) {
      // Only the same paired device may replay the exact same completion.
      // A different payload or companion is not accepted as an idempotent retry.
      return receipt.ownerKeyId === companion.ownerKeyId &&
        safeEqual(receipt.tokenDigest, companion.tokenDigest) &&
        safeEqual(receipt.payloadDigest, payloadDigest);
    }
    const command = this.pending.get(commandId);
    if (!command || command.ownerKeyId !== companion.ownerKeyId || !command.assigned) return false;
    this.completionReceipts.set(commandId, {
      ownerKeyId: companion.ownerKeyId,
      tokenDigest: Buffer.from(companion.tokenDigest),
      payloadDigest,
      completedAt: this.now(),
    });
    while (this.completionReceipts.size > this.maxCompletionReceipts) {
      const oldest = this.completionReceipts.keys().next().value;
      if (oldest === undefined) break;
      this.completionReceipts.delete(oldest);
    }
    this.removePending(commandId);
    if (error) command.reject(new Error("Local desktop action failed: " + safeError(error)));
    else command.resolve(result);
    return true;
  }

  private pruneCompletionReceipts(): void {
    const cutoff = this.now() - this.completionReceiptTtlMs;
    for (const [id, receipt] of this.completionReceipts) {
      if (receipt.completedAt < cutoff) this.completionReceipts.delete(id);
    }
  }

  /** Dispatch one approved action from a Brain run and await its local result. */
  dispatch(
    ownerKeyId: string,
    action: DesktopAction,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    assertDesktopAction(action);
    this.pruneIdle();
    const companion = this.companions.get(ownerKeyId);
    if (!companion) return Promise.reject(new Error("No paired desktop companion is connected."));
    const count = [...this.pending.values()].filter((item) => item.ownerKeyId === ownerKeyId).length;
    if (count >= this.maxPending) return Promise.reject(new Error("Desktop companion queue is full."));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error("Desktop action aborted."));

    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timeoutMs = clamp(options.timeoutMs ?? this.commandTimeoutMs, 1_000, 120_000);
      const timer = setTimeout(() => {
        this.removePending(id);
        reject(new Error("Local desktop companion command timed out."));
      }, timeoutMs);
      const pending: PendingCommand = {
        id,
        action: structuredClone(action),
        createdAt: this.now(),
        ownerKeyId,
        assigned: false,
        resolve,
        reject,
        timer,
        ...(options.signal ? { signal: options.signal } : {}),
      };
      if (options.signal) {
        const abort = () => {
          this.removePending(id);
          reject(options.signal?.reason ?? new Error("Desktop action aborted."));
        };
        pending.abort = abort;
        options.signal.addEventListener("abort", abort, { once: true });
      }
      this.pending.set(id, pending);
    });
  }

  disconnect(ownerKeyId: string): void {
    // Revoke in-memory access and fail closed before touching persistence. A
    // storage outage must never leave an active local session or queued action
    // usable in this process. If deletion fails, surface the failure so the API
    // can report that durable revocation still needs attention.
    this.companions.delete(ownerKeyId);
    for (const [id, command] of this.pending) {
      if (command.ownerKeyId !== ownerKeyId) continue;
      this.removePending(id);
      command.reject(new Error("Paired desktop companion disconnected."));
    }
    this.store?.delete(ownerKeyId);
  }

  getStatus(ownerKeyId: string): { connected: boolean; lastSeenAt?: number; pendingCommands: number } {
    this.pruneIdle();
    const companion = this.companions.get(ownerKeyId);
    return {
      connected: Boolean(companion),
      ...(companion ? { lastSeenAt: companion.lastSeenAt } : {}),
      pendingCommands: [...this.pending.values()].filter((item) => item.ownerKeyId === ownerKeyId).length,
    };
  }

  close(): void {
    this.companions.clear();
    for (const [id, command] of this.pending) {
      this.removePending(id);
      command.reject(new Error("Desktop command broker shut down."));
    }
  }

  private authenticate(token: string): Companion {
    if (!token || token.length > 256) throw new DesktopCompanionAuthenticationError();
    const supplied = digest(token);
    for (const companion of this.companions.values()) {
      if (safeEqual(supplied, companion.tokenDigest)) return companion;
    }
    throw new DesktopCompanionAuthenticationError();
  }

  private pruneIdle(): void {
    const cutoff = this.now() - this.idleTimeoutMs;
    for (const [ownerKeyId, companion] of this.companions) {
      if (companion.lastSeenAt < cutoff) {
        try { this.disconnect(ownerKeyId); }
        catch {
          // Expired credentials are rejected in memory even if disk cleanup fails.
          this.companions.delete(ownerKeyId);
          for (const [id, command] of this.pending) {
            if (command.ownerKeyId !== ownerKeyId) continue;
            this.removePending(id);
            command.reject(new Error("Paired desktop companion disconnected."));
          }
        }
      }
    }
  }

  private persist(companion: Companion): void {
    const record: DesktopCompanionRecord = {
      ownerKeyId: companion.ownerKeyId,
      tokenDigest: companion.tokenDigest.toString("hex"),
      connectedAt: companion.connectedAt,
      lastSeenAt: companion.lastSeenAt,
    };
    this.store?.save(record);
  }

  private touch(companion: Companion): void {
    const lastSeenAt = this.now();
    if (lastSeenAt <= companion.lastSeenAt) return;
    if (lastSeenAt - companion.persistedAt >= 60_000) {
      // Persist before mutating the in-memory heartbeat. If storage is temporarily
      // unavailable, the next poll must retry instead of believing it was saved.
      this.persist({ ...companion, lastSeenAt });
      companion.persistedAt = lastSeenAt;
    }
    companion.lastSeenAt = lastSeenAt;
  }

  private removePending(id: string): void {
    const command = this.pending.get(id);
    if (!command) return;
    clearTimeout(command.timer);
    if (command.abort && command.signal) command.signal.removeEventListener("abort", command.abort);
    this.pending.delete(id);
  }
}

function assertOwner(ownerKeyId: string): void {
  if (!ownerKeyId || ownerKeyId.length > 128 || /[\x00-\x1f\x7f]/.test(ownerKeyId)) {
    throw new Error("A valid authenticated owner key ID is required.");
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : min;
}

function safeError(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 300);
}

export function assertDesktopAction(value: DesktopAction): void {
  if (!value || typeof value !== "object") throw new Error("Invalid desktop action.");
  if (value.kind === "screen.capture") return;
  if (value.kind === "app.launch") {
    if (typeof value.applicationId !== "string" || !value.applicationId.trim() || value.applicationId.length > 128 ||
        !Array.isArray(value.args) || value.args.length > 32 ||
        value.args.some((arg) => typeof arg !== "string" || arg.length > 1000 || arg.includes("\0"))) {
      throw new Error("Invalid desktop application launch action.");
    }
    return;
  }
  if (value.kind === "input.click") {
    if (!Number.isSafeInteger(value.x) || !Number.isSafeInteger(value.y) || value.x < 0 || value.y < 0 ||
        value.x > 16383 || value.y > 16383 ||
        !["left", "right", "middle"].includes(value.button)) {
      throw new Error("Invalid desktop click action.");
    }
    return;
  }
  if (value.kind === "input.type") {
    if (typeof value.text !== "string" || value.text.length > 2000 || value.text.includes("\0")) {
      throw new Error("Invalid desktop text input action.");
    }
    return;
  }
  if (value.kind === "input.key") {
    if (typeof value.key !== "string" || !/^(?:[A-Za-z0-9]|Enter|Escape|Tab|Backspace|Delete|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|Space|F(?:[1-9]|1[0-2])|Ctrl\+[A-Za-z0-9]|Alt\+[A-Za-z0-9]|Shift\+[A-Za-z0-9])$/.test(value.key)) {
      throw new Error("Invalid desktop key input action.");
    }
    return;
  }
  throw new Error("Unsupported desktop action.");
}
