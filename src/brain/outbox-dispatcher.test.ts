import assert from "node:assert/strict";
import test from "node:test";
import { OutboxDispatcher } from "./outbox-dispatcher.js";
import type { OutboxMessage, OutboxStore } from "./postgres-outbox-store.js";

const message: OutboxMessage = {
  id: "00000000-0000-4000-8000-000000000001",
  ownerKeyId: "owner-a",
  jobId: "00000000-0000-4000-8000-000000000002",
  eventType: "job.completed",
  destination: "discord:channel",
  payload: { text: "completed" },
  status: "processing",
  attempts: 1,
  availableAt: "2026-11-03T00:00:00.000Z",
  createdAt: "2026-11-03T00:00:00.000Z",
};

function fakeStore(overrides: Partial<OutboxStore> = {}) {
  const calls: Array<{ kind: string; args: unknown[] }> = [];
  let claimed = false;
  const store: OutboxStore = {
    async enqueue() { return true; },
    async claimBatch(...args) {
      calls.push({ kind: "claim", args });
      if (claimed) return [];
      claimed = true;
      return [message];
    },
    async markDelivered(...args) { calls.push({ kind: "ack", args }); return true; },
    async retry(...args) { calls.push({ kind: "retry", args }); return true; },
    ...overrides,
  };
  return { store, calls };
}

test("dispatcher sends stable message id and acknowledges only after successful send", async () => {
  const { store, calls } = fakeStore();
  let delivered: unknown;
  const dispatcher = new OutboxDispatcher(store, async (item) => { delivered = item; }, {
    workerToken: "worker-token", batchSize: 4, leaseMs: 5000,
  });
  const report = await dispatcher.dispatchOnce();
  assert.equal(report.claimed, 1);
  assert.equal(report.delivered, 1);
  assert.equal(report.retried, 0);
  assert.equal((delivered as { messageId: string }).messageId, message.id);
  assert.equal((delivered as { ownerKeyId: string }).ownerKeyId, "owner-a");
  assert.equal(calls[1]!.kind, "ack");
  assert.deepEqual(calls[1]!.args, [message.id, "worker-token"]);
});

test("dispatcher retries a failed send with bounded exponential delay", async () => {
  const { store, calls } = fakeStore();
  const dispatcher = new OutboxDispatcher(store, async () => { throw new Error("temporary send failure"); }, {
    workerToken: "worker-token", baseRetryDelayMs: 1500, maxRetryDelayMs: 5000, maxAttempts: 4,
  });
  const report = await dispatcher.dispatchOnce();
  assert.equal(report.retried, 1);
  assert.equal(report.failed, 0);
  assert.equal(calls[1]!.kind, "retry");
  assert.equal(calls[1]!.args[0], message.id);
  assert.equal(calls[1]!.args[1], "worker-token");
  assert.equal(calls[1]!.args[3], 1500);
  assert.equal(calls[1]!.args[4], 4);
});

test("dispatcher marks exhausted attempts failed through the store retry contract", async () => {
  const exhausted = { ...message, attempts: 8 };
  let claimed = false;
  const { store, calls } = fakeStore({
    async claimBatch() {
      if (claimed) return [];
      claimed = true;
      return [exhausted];
    },
  });
  const dispatcher = new OutboxDispatcher(store, async () => { throw new Error("send failed"); }, {
    workerToken: "worker-token", maxAttempts: 8,
  });
  const report = await dispatcher.dispatchOnce();
  assert.equal(report.failed, 1);
  assert.equal(calls[1]!.kind, "retry");
  assert.equal(calls[1]!.args[4], 8);
});

test("dispatcher reports a lost lease rather than claiming delivery", async () => {
  const { store } = fakeStore({ async markDelivered() { return false; } });
  const dispatcher = new OutboxDispatcher(store, async () => undefined, { workerToken: "stale-worker" });
  const report = await dispatcher.dispatchOnce();
  assert.equal(report.delivered, 0);
  assert.equal(report.leaseLost, 1);
});


test("dispatcher renews a lease while a long-running sender is active", async () => {
  let renewals = 0;
  let release!: () => void;
  const sendBlocked = new Promise<void>((resolve) => { release = resolve; });
  const { store } = fakeStore({
    async renewLease() { renewals += 1; return true; },
  });
  const dispatcher = new OutboxDispatcher(store, async () => { await sendBlocked; }, {
    workerToken: "worker-token", leaseMs: 1000,
  });
  const dispatch = dispatcher.dispatchOnce();
  await new Promise((resolve) => setTimeout(resolve, 550));
  release();
  const report = await dispatch;
  assert.ok(renewals >= 1);
  assert.equal(report.delivered, 1);
});

test("dispatcher aborts sender and reports lease loss when renewal is fenced out", async () => {
  const { store } = fakeStore({
    async renewLease() { return false; },
  });
  const dispatcher = new OutboxDispatcher(store, async ({ signal }) => {
    await new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }, { workerToken: "worker-token", leaseMs: 1000 });
  const report = await dispatcher.dispatchOnce();
  assert.equal(report.leaseLost, 1);
  assert.equal(report.delivered, 0);
});


test("dispatcher claims each message only when ready to send it", async () => {
  const second = { ...message, id: "00000000-0000-4000-8000-000000000003" };
  const queued = [message, second];
  const claimLimits: number[] = [];
  const sent: string[] = [];
  const store: OutboxStore = {
    async enqueue() { return true; },
    async claimBatch(_worker, limit) {
      claimLimits.push(limit);
      const next = queued.shift();
      return next ? [next] : [];
    },
    async markDelivered() { return true; },
    async retry() { return true; },
  };
  const dispatcher = new OutboxDispatcher(store, async (item) => { sent.push(item.messageId); }, {
    workerToken: "worker-token", batchSize: 5,
  });
  const report = await dispatcher.dispatchOnce();
  assert.deepEqual(claimLimits, [1, 1, 1]);
  assert.deepEqual(sent, [message.id, second.id]);
  assert.equal(report.claimed, 2);
  assert.equal(report.delivered, 2);
});
