import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteApprovalQueue, createQueuedApprovalHandler } from "./approval-queue.js";
import type { ApprovalRequest } from "./approval.js";

const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  runId: "run-1",
  principalId: "owner-a",
  toolName: "skill.lifecycle.promote",
  input: { candidateId: "candidate-1", skillId: "learned:test" },
  actionHash: "a".repeat(64),
  risk: "high",
  ...overrides,
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sofia-approval-"));
  const file = path.join(directory, "approvals.sqlite");
  const queue = await SqliteApprovalQueue.open(file);
  return {
    directory, file, queue,
    async cleanup() { queue.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("approval decisions are private to the owner and bound to the exact action hash", async () => {
  const f = await fixture();
  try {
    const pending = f.queue.create(request());
    assert.equal(f.queue.list("owner-b").length, 0);
    assert.equal(f.queue.decide({
      id: pending.id, ownerId: "owner-b", decidedBy: "owner-b",
      actionHash: pending.actionHash, approved: true,
    }), undefined);
    assert.equal(f.queue.decide({
      id: pending.id, ownerId: "owner-a", decidedBy: "owner-a",
      actionHash: "b".repeat(64), approved: true,
    }), undefined);
    assert.equal(f.queue.get(pending.id, "owner-a")?.status, "pending");
  } finally { await f.cleanup(); }
});

test("approval can be decided only once and records the authenticated decider", async () => {
  const f = await fixture();
  try {
    const pending = f.queue.create(request());
    const approved = f.queue.decide({
      id: pending.id, ownerId: "owner-a", decidedBy: "owner-a",
      actionHash: pending.actionHash, approved: true,
    });
    assert.equal(approved?.status, "approved");
    assert.equal(approved?.decidedBy, "owner-a");
    assert.equal(f.queue.decide({
      id: pending.id, ownerId: "owner-a", decidedBy: "owner-a",
      actionHash: pending.actionHash, approved: false,
    }), undefined);
  } finally { await f.cleanup(); }
});

test("pending approvals survive reopening the SQLite store", async () => {
  const f = await fixture();
  try {
    const pending = f.queue.create(request());
    f.queue.close();
    const reopened = await SqliteApprovalQueue.open(f.file);
    try {
      assert.equal(reopened.get(pending.id, "owner-a")?.status, "pending");
      assert.equal(reopened.list("owner-a")[0]?.actionHash, pending.actionHash);
    } finally { reopened.close(); }
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("queued approval handler resolves only after the owner approves the stored action", async () => {
  const f = await fixture();
  try {
    const handler = createQueuedApprovalHandler(f.queue, { pollMs: 100, ttlMs: 5_000 });
    const pendingDecision = handler(request());
    const pending = f.queue.list("owner-a")[0];
    assert.ok(pending);
    const decision = f.queue.decide({
      id: pending.id, ownerId: "owner-a", decidedBy: "owner-a",
      actionHash: pending.actionHash, approved: true,
    });
    assert.equal(decision?.status, "approved");
    assert.equal(await pendingDecision, true);
  } finally { await f.cleanup(); }
});

test("queued approval handler fails closed when principal identity is missing", async () => {
  const f = await fixture();
  try {
    const handler = createQueuedApprovalHandler(f.queue, { pollMs: 100 });
    assert.equal(await handler(request({ principalId: undefined })), false);
    assert.equal(f.queue.list("owner-a").length, 0);
  } finally { await f.cleanup(); }
});


test("expired approval is denied and cannot later be approved", async () => {
  const f = await fixture();
  try {
    const pending = f.queue.create(request(), { ttlMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    assert.deepEqual(f.queue.list("owner-a"), []);
    assert.equal(f.queue.get(pending.id, "owner-a")?.status, "expired");
    assert.equal(f.queue.decide({
      id: pending.id, ownerId: "owner-a", decidedBy: "owner-a",
      actionHash: pending.actionHash, approved: true,
    }), undefined);
  } finally { await f.cleanup(); }
});


test("queued approval handler notifies the trusted originating channel after durable creation", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let notified: { id: string; ownerId: string; channelId?: string } | undefined;
  try {
    const handler = createQueuedApprovalHandler(f.queue, {
      pollMs: 100,
      onCreated: (record, approvalRequest) => {
        notified = {
          id: record.id,
          ownerId: record.ownerId,
          channelId: approvalRequest.notificationChannelId,
        };
      },
    });
    const pending = handler(request({
      principalId: "discord:12345",
      notificationChannelId: "67890",
      signal: controller.signal,
    }));
    for (let attempt = 0; attempt < 20 && !notified; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(notified);
    assert.equal(notified.ownerId, "discord:12345");
    assert.equal(notified.channelId, "67890");
    assert.equal(f.queue.get(notified.id, "discord:12345")?.status, "pending");
    controller.abort();
    assert.equal(await pending, false);
  } finally { await f.cleanup(); }
});

test("approval notification delivery failure does not approve or crash the waiting handler", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let notificationErrors = 0;
  try {
    const handler = createQueuedApprovalHandler(f.queue, {
      pollMs: 100,
      onCreated: async () => { throw new Error("delivery failed"); },
      onNotificationError: () => { notificationErrors++; },
    });
    const pending = handler(request({ signal: controller.signal }));
    for (let attempt = 0; attempt < 20 && notificationErrors === 0; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(notificationErrors, 1);
    assert.equal(f.queue.list("owner-a").length, 1);
    controller.abort();
    assert.equal(await pending, false);
  } finally { await f.cleanup(); }
});
