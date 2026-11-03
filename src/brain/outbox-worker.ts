import type { OutboxDispatchReport, OutboxDispatcher } from "./outbox-dispatcher.js";

export interface OutboxWorkerOptions {
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
}

/**
 * Host-managed polling worker. Call start() from a trusted long-lived process
 * (for example a Vercel Daemon); call stop() during graceful shutdown.
 * This class deliberately does not create its own process or schedule itself
 * in serverless request handlers.
 */
export class OutboxWorker {
  private stopped = true;
  private loopPromise?: Promise<void>;
  private wake?: () => void;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly dispatcher: Pick<OutboxDispatcher, "dispatchOnce">,
    private readonly options: OutboxWorkerOptions = {},
  ) {
    this.pollIntervalMs = Math.max(250, Math.min(60000, Math.floor(options.pollIntervalMs ?? 2000)));
  }

  start(): Promise<void> {
    if (this.loopPromise) return this.loopPromise;
    this.stopped = false;
    this.loopPromise = this.runLoop().finally(() => {
      this.loopPromise = undefined;
      this.wake = undefined;
    });
    return this.loopPromise;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.loopPromise;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      let report: OutboxDispatchReport | undefined;
      try {
        report = await this.dispatcher.dispatchOnce();
      } catch (error) {
        try { this.options.onError?.(error); } catch { /* Error observers cannot kill the worker. */ }
      }
      if (this.stopped) break;
      // Back off when idle; keep the configured cadence after work or errors.
      const delay = report && report.claimed > 0 ? Math.min(1000, this.pollIntervalMs) : this.pollIntervalMs;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.wake = undefined;
          resolve();
        }, delay);
        timer.unref?.();
        this.wake = () => {
          clearTimeout(timer);
          this.wake = undefined;
          resolve();
        };
      });
    }
  }
}
