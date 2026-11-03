import { randomUUID } from "node:crypto";
import { redactSecrets } from "../security/guard.js";
import type { OutboxMessage, OutboxStore } from "./postgres-outbox-store.js";

export interface OutboxDeliveryContext {
  /** Stable id for receiver-side deduplication across retries. */
  messageId: string;
  ownerKeyId?: string;
  jobId: string;
  eventType: string;
  destination: string;
  payload: unknown;
  /** Aborted when lease renewal fails or the dispatcher is shutting down. */
  signal?: AbortSignal;
}
export type OutboxSender = (message: OutboxDeliveryContext) => Promise<void>;
export interface OutboxDispatcherOptions {
  workerToken?: string;
  batchSize?: number;
  leaseMs?: number;
  maxAttempts?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}
export interface OutboxDispatchReport {
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
  leaseLost: number;
}
function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return String(redactSecrets(message)).slice(0, 2000);
}
function retryDelay(attempts: number, base: number, maximum: number): number {
  const exponent = Math.min(30, Math.max(0, attempts - 1));
  return Math.min(maximum, base * (2 ** exponent));
}

/**
 * Dispatches claimed outbox messages sequentially. Delivery is at-least-once:
 * a crash after the remote side effect but before acknowledgement can redeliver.
 * Receivers should deduplicate using messageId. Stores supporting renewLease
 * receive periodic lease extensions while a send is in progress. Senders should
 * honor the supplied AbortSignal and still use bounded transport timeouts.
 */
export class OutboxDispatcher {
  private readonly workerToken: string;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;

  constructor(
    private readonly store: OutboxStore,
    private readonly send: OutboxSender,
    options: OutboxDispatcherOptions = {},
  ) {
    this.workerToken = options.workerToken ?? randomUUID();
    this.batchSize = Math.max(1, Math.min(100, Math.floor(options.batchSize ?? 10)));
    this.leaseMs = Math.max(1000, Math.min(300000, Math.floor(options.leaseMs ?? 30000)));
    this.maxAttempts = Math.max(1, Math.min(100, Math.floor(options.maxAttempts ?? 8)));
    this.baseRetryDelayMs = Math.max(100, Math.min(60000, Math.floor(options.baseRetryDelayMs ?? 1000)));
    this.maxRetryDelayMs = Math.max(this.baseRetryDelayMs, Math.min(86400000, Math.floor(options.maxRetryDelayMs ?? 300000)));
  }

  async dispatchOnce(): Promise<OutboxDispatchReport> {
    const report: OutboxDispatchReport = {
      claimed: 0, delivered: 0, retried: 0, failed: 0, leaseLost: 0,
    };
    // Claim one at a time: claiming a whole batch and sending sequentially lets
    // later messages' leases expire while they wait behind a slow first send.
    for (let index = 0; index < this.batchSize; index += 1) {
      const [message] = await this.store.claimBatch(this.workerToken, 1, this.leaseMs);
      if (!message) break;
      report.claimed += 1;
      await this.dispatchMessage(message, report);
    }
    return report;
  }

  private async dispatchMessage(message: OutboxMessage, report: OutboxDispatchReport): Promise<void> {
    const controller = new AbortController();
    let stopRenewal = false;
    let renewalTimer: ReturnType<typeof setTimeout> | undefined;
    let stopRenewalWait: (() => void) | undefined;
    let leaseLost = false;
    const renew = this.store.renewLease;
    const renewalTask = renew ? (async () => {
      const intervalMs = Math.max(250, Math.floor(this.leaseMs / 3));
      while (!stopRenewal) {
        await new Promise<void>((resolve) => {
          renewalTimer = setTimeout(() => {
            renewalTimer = undefined;
            stopRenewalWait = undefined;
            resolve();
          }, intervalMs);
          stopRenewalWait = () => {
            if (renewalTimer) clearTimeout(renewalTimer);
            renewalTimer = undefined;
            stopRenewalWait = undefined;
            resolve();
          };
        });
        if (stopRenewal) return;
        try {
          const renewed = await renew.call(this.store, message.id, this.workerToken, this.leaseMs);
          if (!renewed) {
            leaseLost = true;
            controller.abort(new Error("Outbox lease lost during delivery"));
            return;
          }
        } catch {
          leaseLost = true;
          controller.abort(new Error("Outbox lease renewal failed"));
          return;
        }
      }
    })() : Promise.resolve();

    let sendError: unknown;
    try {
      await this.send({
        messageId: message.id,
        ...(message.ownerKeyId ? { ownerKeyId: message.ownerKeyId } : {}),
        jobId: message.jobId,
        eventType: message.eventType,
        destination: message.destination,
        payload: message.payload,
        signal: controller.signal,
      });
    } catch (error) {
      sendError = error;
    } finally {
      // Stop and join renewal before ACK/retry. This prevents a late heartbeat
      // racing with terminal acknowledgement or extending an already-finished lease.
      stopRenewal = true;
      stopRenewalWait?.();
      await renewalTask;
    }

    if (leaseLost) {
      report.leaseLost += 1;
      return;
    }
    if (sendError === undefined) {
      const acknowledged = await this.store.markDelivered(message.id, this.workerToken);
      if (acknowledged) report.delivered += 1;
      else report.leaseLost += 1;
      return;
    }

    const delay = retryDelay(message.attempts, this.baseRetryDelayMs, this.maxRetryDelayMs);
    const updated = await this.store.retry(
      message.id, this.workerToken, safeError(sendError), delay, this.maxAttempts,
    );
    if (!updated) report.leaseLost += 1;
    else if (message.attempts >= this.maxAttempts) report.failed += 1;
    else report.retried += 1;
  }
}
