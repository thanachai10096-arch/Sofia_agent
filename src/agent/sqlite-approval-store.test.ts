import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteApprovalStore } from "./sqlite-approval-store.js";
import type { ApprovalAuditRecord } from "./approval.js";

const record: ApprovalAuditRecord = {
  id: "approval-1",
  runId: "run-1",
  principalId: "owner-a",
  toolName: "workspace.write_file",
  actionHash: "sha256-action-a",
  risk: "high",
  status: "pending",
  createdAt: 1_000,
  expiresAt: 10_000,
};

async function withStores(run: (first: SqliteApprovalStore, second: SqliteApprovalStore, file: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-approval-sqlite-"));
  const file = path.join(root, "approvals.sqlite");
  const first = await SqliteApprovalStore.open(file);
  const second = await SqliteApprovalStore.open(file);
  try {
    await run(first, second, file);
  } finally {
    first.close();
    second.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("SQLite approval store allows only one decision across independent connections", async () => {
  await withStores(async (first, second) => {
    assert.equal(first.createPending(record), true);
    assert.equal(second.settlePending(record.id, "owner-a", record.actionHash, "approved", 2_000), true);
    assert.equal(first.settlePending(record.id, "owner-a", record.actionHash, "rejected", 2_001), false);
    assert.equal(first.history("owner-a")[0]?.status, "approved");
    assert.deepEqual(second.pending("owner-a"), []);
  });
});

test("SQLite approval store binds decisions to owner and exact action hash", async () => {
  await withStores(async (first, second) => {
    assert.equal(first.createPending(record), true);
    assert.equal(second.settlePending(record.id, "owner-b", record.actionHash, "approved", 2_000), false);
    assert.equal(second.settlePending(record.id, "owner-a", "different-hash", "approved", 2_000), false);
    assert.equal(first.pending("owner-a").length, 1);
    assert.equal(first.history("owner-b").length, 0);
    assert.equal(second.settlePending(record.id, "owner-a", record.actionHash, "rejected", 2_000), true);
  });
});

test("SQLite approval store rejects duplicate IDs and never stores proposed tool input", async () => {
  await withStores(async (first, _second, file) => {
    assert.equal(first.createPending({ ...record, input: { content: "sensitive-proposed-input" } } as ApprovalAuditRecord), true);
    assert.equal(first.createPending(record), false);
    const raw = fs.readFileSync(file, "utf8");
    assert.equal(raw.includes("sensitive-proposed-input"), false);
  });
});

test("SQLite approval store expires pending requests atomically", async () => {
  await withStores(async (first, second) => {
    assert.equal(first.createPending(record), true);
    assert.equal(second.expirePending(10_000), 1);
    assert.equal(first.expirePending(10_001), 0);
    assert.equal(first.settlePending(record.id, "owner-a", record.actionHash, "approved", 10_002), false);
    assert.equal(first.history("owner-a")[0]?.status, "expired");
  });
});

test("SQLite approval store refuses expired decisions and supports schema reopen", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-approval-reopen-"));
  const file = path.join(root, "approvals.sqlite");
  try {
    const first = await SqliteApprovalStore.open(file);
    assert.equal(first.createPending(record), true);
    assert.equal(first.settlePending(record.id, "owner-a", record.actionHash, "approved", 10_000), false);
    first.close();
    const reopened = await SqliteApprovalStore.open(file);
    try {
      assert.equal(reopened.history("owner-a")[0]?.status, "pending");
      assert.equal(reopened.expirePending(10_000), 1);
      assert.equal(reopened.history("owner-a")[0]?.status, "expired");
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
