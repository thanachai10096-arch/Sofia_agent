import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalBroker, InMemoryApprovalDecisionStore } from "./approval-broker.js";

test("approval broker exposes a pending action and accepts one exact hash-bound decision", async () => {
  const store = new InMemoryApprovalDecisionStore();
  const broker = new ApprovalBroker({ store, ttlMs: 5_000, pollIntervalMs: 25 });
  const pending = broker.handle({
    runId: "run-1",
    principalId: "principal-1",
    toolName: "workspace.write_file",
    input: { path: "secret.txt", content: "safe", apiKey: "secret-value" },
    actionHash: "a".repeat(64),
    risk: "high",
  });

  const [record] = await broker.listPending("principal-1");
  assert.ok(record);
  assert.equal(record.runId, "run-1");
  assert.equal(record.toolName, "workspace.write_file");
  assert.equal(record.actionHash, "a".repeat(64));
  assert.equal(JSON.stringify(record.input).includes("secret-value"), false);
  assert.equal(await broker.approve(record.id, "b".repeat(64), "principal-1"), false);
  assert.equal(await broker.approve(record.id, record.actionHash, "another-principal"), false, "another principal cannot decide this request");
  assert.equal(await broker.approve(record.id, record.actionHash, "principal-1"), true);
  assert.equal(await pending, true);
  assert.equal(await broker.deny(record.id, record.actionHash, "principal-1"), false, "terminal decisions cannot be replayed");
});


test("approval broker rejects malformed action hashes before creating an approval", async () => {
  const store = new InMemoryApprovalDecisionStore();
  const broker = new ApprovalBroker({ store });
  assert.equal(await broker.handle({
    runId: "run-invalid-hash",
    principalId: "principal-1",
    toolName: "workspace.write_file",
    input: {},
    actionHash: "not-a-sha256-digest",
    risk: "high",
  }), false);
  assert.deepEqual(await broker.listPending("principal-1"), []);
  assert.equal(await broker.approve("missing", "not-a-sha256-digest", "principal-1"), false);
});

test("approval broker denies requests without a trusted principal", async () => {
  const broker = new ApprovalBroker({ store: new InMemoryApprovalDecisionStore() });
  assert.equal(await broker.handle({
    runId: "run-2",
    toolName: "workspace.write_file",
    input: {},
    actionHash: "hash",
    risk: "high",
  }), false);
  assert.deepEqual(await broker.listPending("principal-1"), []);
});

test("approval broker expires requests and denies late approvals", async () => {
  const store = new InMemoryApprovalDecisionStore();
  let now = 10_000;
  const broker = new ApprovalBroker({ store, ttlMs: 1_000, pollIntervalMs: 25, now: () => now });
  const pending = broker.handle({
    runId: "run-expire",
    principalId: "principal-1",
    toolName: "process.execute",
    input: { command: "unsafe" },
    actionHash: "c".repeat(64),
    risk: "critical",
  });
  const [record] = await broker.listPending("principal-1");
  assert.ok(record);
  now = record.expiresAt + 1;
  assert.equal(await broker.approve(record.id, record.actionHash, "principal-1"), false, "approval after expiry must be rejected even before the waiter polls");
  assert.equal(await pending, false);
  assert.equal(await broker.approve(record.id, record.actionHash, "principal-1"), false);
  assert.equal((await store.get(record.id))?.status, "expired");
});

test("approval broker observes aborts that occur while registering the abort listener", async () => {
  const store = new InMemoryApprovalDecisionStore();
  const broker = new ApprovalBroker({ store, ttlMs: 5_000, pollIntervalMs: 10_000 });
  const signal = {
    aborted: false,
    addEventListener() { this.aborted = true; },
    removeEventListener() {},
  } as unknown as AbortSignal;
  assert.equal(await broker.handle({
    runId: "run-abort-registration-race",
    principalId: "principal-1",
    toolName: "workspace.write_file",
    input: {},
    actionHash: "f".repeat(64),
    risk: "high",
    signal,
  }), false);
  const [record] = await store.listPending("principal-1");
  assert.equal(record, undefined, "the raced abort must cancel rather than leave a pending approval");
});

test("approval broker cancels a pending request when its run is aborted", async () => {
  const store = new InMemoryApprovalDecisionStore();
  const broker = new ApprovalBroker({ store, ttlMs: 5_000, pollIntervalMs: 25 });
  const controller = new AbortController();
  const pending = broker.handle({
    runId: "run-abort",
    principalId: "principal-1",
    toolName: "workspace.write_file",
    input: {},
    actionHash: "d".repeat(64),
    risk: "high",
    signal: controller.signal,
  });
  const [record] = await broker.listPending("principal-1");
  assert.ok(record);
  controller.abort(new Error("run cancelled"));
  assert.equal(await pending, false);
  assert.equal((await store.get(record.id))?.status, "cancelled");
});

test("approval broker validates its expiry and polling bounds", () => {
  const store = new InMemoryApprovalDecisionStore();
  assert.throws(() => new ApprovalBroker({ store, ttlMs: 10 }), /TTL/);
  assert.throws(() => new ApprovalBroker({ store, pollIntervalMs: 1 }), /poll interval/);
});


test("approval broker bounds the serialized review payload", async () => {
  const broker = new ApprovalBroker({ store: new InMemoryApprovalDecisionStore() });
  await assert.rejects(broker.handle({
    runId: "run-large-input", principalId: "principal-1", toolName: "workspace.write_file",
    input: { content: "x".repeat(70 * 1024) }, actionHash: "e".repeat(64), risk: "high",
  }), /64 KiB limit/);
  assert.deepEqual(await broker.listPending("principal-1"), []);
});


test("in-memory approval store enforces the per-principal pending cap", async () => {
  const store = new InMemoryApprovalDecisionStore();
  for (let index = 0; index < 50; index += 1) {
    await store.create({
      id: "memory-quota-" + index, runId: "run-" + index, principalId: "principal-1",
      toolName: "workspace.write_file", input: {}, actionHash: "hash-" + index,
      risk: "high", status: "pending", createdAt: index, expiresAt: 60_000 + index,
    });
  }
  await assert.rejects(store.create({
    id: "memory-quota-overflow", runId: "run-overflow", principalId: "principal-1",
    toolName: "workspace.write_file", input: {}, actionHash: "hash-overflow",
    risk: "high", status: "pending", createdAt: 100, expiresAt: 60_100,
  }), /Too many pending approval requests/);
  assert.equal((await store.listPending("principal-1")).length, 50);
});
