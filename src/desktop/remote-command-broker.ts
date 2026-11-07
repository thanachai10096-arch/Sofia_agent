import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DesktopAction } from "./types.js";

export interface DesktopCompanionCommand {
  id: string;
  action: DesktopAction;
  createdAt: number;
}

interface Companion {
  ownerKeyId: string;
  tokenDigest: Buffer;
  connectedAt: number;
  lastSeenAt: number;
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

export interface DesktopCommandBrokerConfig {
  now?: () => number;
  commandTimeoutMs?: number;
  companionIdleTimeoutMs?: number;
  maxPendingPerOwner?: number;
}

/**
 * In-memory relay between a cloud Brain and one explicitly paired local desktop.
 * The companion authenticates with a high-entropy bearer token; only its digest is
 * retained. Commands are owner-bound, single-claim, single-completion, bounded,
 * and fail closed on disconnect, timeout, or process restart.
 *
 * This class is transport-neutral. An API route must authenticate the Sofia API
 * key and its desktop:connect scope before calling connect/poll/complete.
 */
export class DesktopCommandBroker {
  private readonly now: () => number;
  private readonly commandTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxPending: number;
  private readonly companions = new Map<string, Companion>();
  private readonly pending = new Map<string, PendingCommand>();

  constructor(config: DesktopCommandBrokerConfig = {}) {
    this.now = config.now ?? Date.now;
    this.commandTimeoutMs = clamp(config.commandTimeoutMs ?? 30_000, 1_000, 120_000);
    this.idleTimeoutMs = clamp(config.companionIdleTimeoutMs ?? 45_000, 5_000, 300_000);
    this.maxPending = clamp(config.maxPendingPerOwner ?? 8, 1, 64);
  }

  /** Replace any previous companion for this owner and issue a one-time secret. */
  connect(ownerKeyId: string): { token: string; connectedAt: number } {
    assertOwner(ownerKeyId);
    this.disconnect(ownerKeyId);
    const token = randomBytes(32).toString("base64url");
    const connectedAt = this.now();
    this.companions.set(ownerKeyId, {
      ownerKeyId,
      tokenDigest: digest(token),
      connectedAt,
      lastSeenAt: connectedAt,
    });
    return { token, connectedAt };
  }

  /** Returns the next command once. Re-polling never re-delivers an assigned command. */
  poll(token: string): DesktopCompanionCommand | null {
    const companion = this.authenticate(token);
    companion.lastSeenAt = this.now();
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
    companion.lastSeenAt = this.now();
    const command = this.pending.get(commandId);
    if (!command || command.ownerKeyId !== companion.ownerKeyId || !command.assigned) return false;
    this.removePending(commandId);
    if (error) command.reject(new Error("Local desktop action failed: " + safeError(error)));
    else command.resolve(result);
    return true;
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
    this.companions.delete(ownerKeyId);
    for (const [id, command] of this.pending) {
      if (command.ownerKeyId !== ownerKeyId) continue;
      this.removePending(id);
      command.reject(new Error("Paired desktop companion disconnected."));
    }
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
    if (!token || token.length > 256) throw new Error("Invalid desktop companion token.");
    const supplied = digest(token);
    for (const companion of this.companions.values()) {
      if (safeEqual(supplied, companion.tokenDigest)) return companion;
    }
    throw new Error("Desktop companion is not paired or its token was revoked.");
  }

  private pruneIdle(): void {
    const cutoff = this.now() - this.idleTimeoutMs;
    for (const [ownerKeyId, companion] of this.companions) {
      if (companion.lastSeenAt < cutoff) this.disconnect(ownerKeyId);
    }
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
