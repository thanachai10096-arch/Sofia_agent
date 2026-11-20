import assert from "node:assert/strict";
import test from "node:test";
import { openRunOwnershipSession } from "./run-ownership-session.js";
import type { RunOwnershipLease, RunOwnershipStore } from "./run-ownership-store.js";

const lease: RunOwnershipLease = {
  runId: "run-session-0001",
  principalId: "tenant-alpha",
  instanceId: "worker-a",
  token: "session_token_12345678901234567890",
  generation: 3,
};

function fakeStore(overrides: Partial<RunOwnershipStore> = {}) {
  const calls = { claim: 0, renew: 0, assertCurrent: 0, release: 0 };
  const store: RunOwnershipStore = {
    async claim() { calls.claim += 1; return lease; },
    async renew() { calls.renew += 1; return true; },
    async assertCurrent() { calls.assertCurrent += 1; return true; },
    async release() { calls.release += 1; return true; },
    ...overrides,
  };
  return { store, calls };
}

test("ownership session acquires, asserts, renews and releases the exact lease", async () => {
  const { store, calls } = fakeStore();
  const session = await openRunOwnershipSession({
    store, runId: lease.runId, principalId: lease.principalId,
    instanceId: lease.instanceId, leaseMs: 1200, heartbeatMs: 200,
  });
  assert.ok(session);
  assert.equal(session.lease.generation, lease.generation);
  await session.assertCurrent();
  await new Promise((resolve) => setTimeout(resolve, 240));
  await session.close();
  assert.equal(calls.claim, 1);
  assert.ok(calls.renew >= 1);
  assert.equal(calls.assertCurrent, 1);
  assert.equal(calls.release, 1);
});

test("ownership session aborts and rejects when heartbeat renewal loses the lease", async () => {
  const controller = new AbortController();
  const { store, calls } = fakeStore({
    async renew() { calls.renew += 1; return false; },
  });
  const session = await openRunOwnershipSession({
    store, runId: lease.runId, principalId: lease.principalId,
    instanceId: lease.instanceId, leaseMs: 1200, heartbeatMs: 100,
    signal: controller,
  });
  assert.ok(session);
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(controller.signal.aborted, true);
  await assert.rejects(session.assertCurrent(), /ownership lease was lost/i);
  await session.close();
  assert.equal(calls.renew >= 1, true);
  assert.equal(calls.release, 1);
});

test("ownership session fails closed when claim is already held", async () => {
  const { store, calls } = fakeStore({ async claim() { calls.claim += 1; return undefined; } });
  const session = await openRunOwnershipSession({
    store, runId: lease.runId, principalId: lease.principalId,
    instanceId: lease.instanceId, leaseMs: 1200, heartbeatMs: 200,
  });
  assert.equal(session, undefined);
  assert.equal(calls.renew, 0);
  assert.equal(calls.release, 0);
});

test("ownership session rejects unsafe heartbeat intervals before claiming", async () => {
  const { store, calls } = fakeStore();
  await assert.rejects(openRunOwnershipSession({
    store, runId: lease.runId, principalId: lease.principalId,
    instanceId: lease.instanceId, leaseMs: 1200, heartbeatMs: 700,
  }), /less than half/i);
  assert.equal(calls.claim, 0);
});
