import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteApprovalDecisionStore } from "./sqlite-approval-store.js";
import type { ApprovalRecord } from "./approval-broker.js";

function record(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: "approval-1",
    runId: "run-1",
    principalId: "principal-1",
    toolName: "workspace.write_file",
    input: { path: "safe.txt", content: "safe" },
    actionHash: "a".repeat(64),
    risk: "high",
    status: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

test("simultaneous SQLite store initialization serializes schema migration", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-approval-migrate-race-"));
  const file = path.join(dir, "approvals.sqlite");
  let first: SqliteApprovalDecisionStore | undefined;
  let second: SqliteApprovalDecisionStore | undefined;
  try {
    [first, second] = await Promise.all([
      SqliteApprovalDecisionStore.open(file),
      SqliteApprovalDecisionStore.open(file),
    ]);
    await first.create(record());
    assert.equal((await second.get("approval-1"))?.status, "pending");
  } finally {
    first?.close();
    second?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite approval decisions survive restart and remain scoped to their principal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-approval-restart-"));
  const file = path.join(dir, "approvals.sqlite");
  try {
    const first = await SqliteApprovalDecisionStore.open(file);
    await first.create(record());
    first.close();

    const second = await SqliteApprovalDecisionStore.open(file);
    try {
      assert.equal((await second.get("approval-1"))?.actionHash, "a".repeat(64));
      assert.equal((await second.listPending("principal-1")).length, 1);
      assert.deepEqual(await second.listPending("principal-other"), []);
      assert.deepEqual(await second.listPending(""), []);
    } finally {
      second.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite conditional updates permit exactly one decision across connections", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-approval-race-"));
  const file = path.join(dir, "approvals.sqlite");
  const first = await SqliteApprovalDecisionStore.open(file);
  const second = await SqliteApprovalDecisionStore.open(file);
  try {
    await first.create(record());
    const decisionTime = Date.now() + 1;
    const results = await Promise.all([
      first.resolve("approval-1", "a".repeat(64), "approved", "principal-1", decisionTime),
      second.resolve("approval-1", "a".repeat(64), "denied", "principal-1", decisionTime),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.ok(["approved", "denied"].includes((await first.get("approval-1"))?.status ?? ""));
    assert.equal(await second.resolve("approval-1", "a".repeat(64), "approved", "principal-1", decisionTime + 1), false);
  } finally {
    first.close();
    second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite approval store rejects wrong hashes and expires late decisions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-approval-expiry-"));
  const store = await SqliteApprovalDecisionStore.open(path.join(dir, "approvals.sqlite"));
  try {
    const now = Date.now();
    await store.create(record({ id: "late", expiresAt: now + 1_000 }));
    assert.equal(await store.resolve("late", "b".repeat(64), "approved", "principal-1", now + 500), false);
    assert.equal(await store.resolve("late", "a".repeat(64), "approved", "principal-1", now + 1_001), false);
    assert.equal((await store.get("late"))?.status, "expired");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite approval database and sidecars are private on POSIX", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-approval-permissions-"));
  const file = path.join(dir, "approvals.sqlite");
  const store = await SqliteApprovalDecisionStore.open(file);
  try {
    await store.create(record());
    for (const target of [file, file + "-wal", file + "-shm"]) {
      try {
        const mode = fs.statSync(target).mode & 0o777;
        assert.equal(mode & 0o077, 0, target + " must not be accessible to group/other");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("SQLite store caps pending approvals atomically per principal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-approval-quota-"));
  const file = path.join(dir, "approvals.sqlite");
  const first = await SqliteApprovalDecisionStore.open(file);
  const second = await SqliteApprovalDecisionStore.open(file);
  try {
    for (let index = 0; index < 50; index += 1) await first.create(record({ id: "quota-" + index }));
    await assert.rejects(second.create(record({ id: "quota-overflow" })), /Too many pending approval requests/);
    assert.equal((await second.listPending("principal-1")).length, 50);
    await second.resolve("quota-0", "a".repeat(64), "denied", "principal-1", Date.now());
    await first.create(record({ id: "quota-after-decision" }));
    assert.equal((await second.listPending("principal-1")).length, 50);
  } finally {
    first.close(); second.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("SQLite approval store enforces resolver ownership inside the atomic update", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-approval-owner-cas-"));
  const store = await SqliteApprovalDecisionStore.open(path.join(dir, "approvals.sqlite"));
  try {
    await store.create(record({ id: "owner-bound-sqlite" }));
    assert.equal(await store.resolve("owner-bound-sqlite", "a".repeat(64), "approved", "attacker", Date.now()), false);
    assert.equal((await store.get("owner-bound-sqlite"))?.status, "pending");
    assert.equal(await store.resolve("owner-bound-sqlite", "a".repeat(64), "approved", "principal-1", Date.now()), true);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
