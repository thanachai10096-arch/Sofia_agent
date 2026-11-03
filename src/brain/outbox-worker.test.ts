import assert from "node:assert/strict";
import test from "node:test";
import { OutboxWorker } from "./outbox-worker.js";

test("worker waits for an active dispatch before graceful stop completes", async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const worker = new OutboxWorker({
    async dispatchOnce() {
      calls += 1;
      entered();
      await blocked;
      return { claimed: 1, delivered: 1, retried: 0, failed: 0, leaseLost: 0 };
    },
  }, { pollIntervalMs: 250 });

  const running = worker.start();
  await started;
  const stopping = worker.stop();
  release();
  await stopping;
  await running;
  assert.equal(calls, 1);
});

test("worker start is idempotent while its loop is active", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const worker = new OutboxWorker({
    async dispatchOnce() {
      calls += 1;
      await blocked;
      return { claimed: 0, delivered: 0, retried: 0, failed: 0, leaseLost: 0 };
    },
  });
  const first = worker.start();
  const second = worker.start();
  assert.equal(first, second);
  const stopping = worker.stop();
  release();
  await stopping;
  assert.equal(calls, 1);
});
