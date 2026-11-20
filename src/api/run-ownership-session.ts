import { randomBytes } from "node:crypto";
import type { RunOwnershipLease, RunOwnershipStore } from "./run-ownership-store.js";

export interface RunOwnershipSession {
  readonly lease: RunOwnershipLease;
  /** Throws and aborts the run when the lease is no longer current. */
  assertCurrent(): Promise<void>;
  /** Stops renewal and conditionally releases this exact fencing generation. */
  close(): Promise<void>;
}

/**
 * Acquires and maintains one distributed Run lease. Redis is authoritative:
 * heartbeat errors are treated as lease loss, never as permission to continue.
 */
export async function openRunOwnershipSession(options: {
  store: RunOwnershipStore;
  runId: string;
  principalId: string;
  instanceId: string;
  leaseMs: number;
  heartbeatMs?: number;
  signal?: AbortController;
}): Promise<RunOwnershipSession | undefined> {
  const heartbeatMs = options.heartbeatMs ?? Math.floor(options.leaseMs / 3);
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1000 || options.leaseMs > 300_000 ||
      !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 100 || heartbeatMs >= options.leaseMs / 2) {
    throw new Error("Run ownership heartbeat must be at least 100ms and less than half the lease duration.");
  }
  const token = randomBytes(24).toString("base64url");
  const lease = await options.store.claim({
    runId: options.runId,
    principalId: options.principalId,
    instanceId: options.instanceId,
    token,
    leaseMs: options.leaseMs,
  });
  if (!lease) return undefined;

  let lost: Error | undefined;
  let closed = false;
  let heartbeat: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  const lose = (reason: unknown) => {
    if (lost) return;
    lost = new Error("Run ownership lease was lost; execution stopped.", { cause: reason });
    options.signal?.abort(lost);
  };
  const assertCurrent = async () => {
    if (closed) throw new Error("Run ownership session is closed.");
    if (lost) throw lost;
    try {
      if (!await options.store.assertCurrent(lease)) {
        lose(new Error("Fencing generation is no longer current."));
        throw lost;
      }
    } catch (error) {
      lose(error);
      throw lost;
    }
  };
  heartbeat = setInterval(() => {
    if (closed || lost) return;
    inFlight = inFlight.then(async () => {
      if (closed || lost) return;
      try {
        if (!await options.store.renew(lease, options.leaseMs)) lose(new Error("Lease renewal was rejected."));
      } catch (error) {
        lose(error);
      }
    });
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    lease,
    assertCurrent,
    async close() {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      await inFlight;
      // A lost/stale generation can never release a newer owner's lease.
      try { await options.store.release(lease); }
      catch (error) {
        if (!lost) throw error;
      }
    },
  };
}
