import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Aes256GcmApprovalPayloadCipher } from "./approval-payload-cipher.js";
import { DurableApprovalBroker } from "./durable-approval-broker.js";
import { DurableApprovalCoordinator } from "./durable-approval-coordinator.js";
import { SqliteApprovalStore } from "./sqlite-approval-store.js";
import { SqliteApprovalPayloadStore } from "./sqlite-approval-payload-store.js";

const [major, minor] = process.versions.node.split(".").map(Number);
const supportsSqlite = major > 22 || (major === 22 && minor >= 5);

test("durable broker lets a separate reviewer worker inspect and decide an origin worker approval", {
  skip: !supportsSqlite,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-durable-broker-"));
  const file = path.join(root, "approvals.sqlite");
  const originStore = await SqliteApprovalStore.open(file);
  const reviewerStore = await SqliteApprovalStore.open(file);
  const originPayloads = await SqliteApprovalPayloadStore.open(file);
  const reviewerPayloads = await SqliteApprovalPayloadStore.open(file);
  const key = randomBytes(32);
  const originCipher = new Aes256GcmApprovalPayloadCipher(key, "broker-test-v1");
  const reviewerCipher = new Aes256GcmApprovalPayloadCipher(key, "broker-test-v1");
  const originCoordinator = new DurableApprovalCoordinator(originStore, originPayloads, originCipher, {
    ttlMs: 10_000,
    pollIntervalMs: 50,
  });
  const reviewerCoordinator = new DurableApprovalCoordinator(reviewerStore, reviewerPayloads, reviewerCipher);
  const origin = new DurableApprovalBroker(originStore, originPayloads, originCoordinator);
  const reviewer = new DurableApprovalBroker(reviewerStore, reviewerPayloads, reviewerCoordinator);
  const request = {
    runId: "run-cross-worker",
    principalId: "tenant-cross-worker",
    toolName: "browser.purchase",
    input: { item: "coffee", quantity: 1 },
    actionHash: "sha256-cross-worker-action",
    risk: "high" as const,
  };

  try {
    const execution = origin.handle(request);
    const [pending] = reviewer.pending("tenant-cross-worker");
    assert.ok(pending);
    assert.deepEqual(pending.input, request.input);
    assert.deepEqual(reviewer.pending("another-tenant"), []);
    assert.equal(reviewer.decide({
      approvalId: pending.id,
      principalId: "tenant-cross-worker",
      actionHash: "wrong-action",
      approved: true,
    }), false);
    assert.equal(reviewer.decide({
      approvalId: pending.id,
      principalId: "another-tenant",
      actionHash: request.actionHash,
      approved: true,
    }), false);
    assert.equal(reviewer.decide({
      approvalId: pending.id,
      principalId: "tenant-cross-worker",
      actionHash: request.actionHash,
      approved: true,
    }), true);
    assert.equal(await execution, true);
    assert.equal(reviewer.pending("tenant-cross-worker").length, 0);
    assert.equal(reviewer.history("tenant-cross-worker")[0]?.status, "approved");
  } finally {
    reviewerPayloads.close();
    originPayloads.close();
    reviewerStore.close();
    originStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("durable broker cancellation is scoped to owner and run", {
  skip: !supportsSqlite,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-durable-broker-cancel-"));
  const file = path.join(root, "approvals.sqlite");
  const store = await SqliteApprovalStore.open(file);
  const payloads = await SqliteApprovalPayloadStore.open(file);
  const cipher = new Aes256GcmApprovalPayloadCipher(randomBytes(32), "broker-cancel-v1");
  const coordinator = new DurableApprovalCoordinator(store, payloads, cipher, {
    ttlMs: 10_000,
    pollIntervalMs: 50,
  });
  const broker = new DurableApprovalBroker(store, payloads, coordinator);
  try {
    const execution = broker.handle({
      runId: "run-cancel",
      principalId: "tenant-cancel",
      toolName: "workspace.write_file",
      input: { path: "safe.txt" },
      actionHash: "sha256-cancel",
      risk: "high",
    });
    assert.equal(broker.cancelRun("run-cancel", "other-tenant"), 0);
    assert.equal(broker.cancelRun("another-run", "tenant-cancel"), 0);
    assert.equal(broker.cancelRun("run-cancel", "tenant-cancel"), 1);
    assert.equal(await execution, false);
    assert.equal(broker.history("tenant-cancel")[0]?.status, "cancelled");
  } finally {
    payloads.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
