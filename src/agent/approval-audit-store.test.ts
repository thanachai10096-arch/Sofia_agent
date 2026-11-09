import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileApprovalAuditStore } from "./approval-audit-store.js";

const event = {
  approvalId: "approval-1", ownerId: "owner-a", runId: "run-1",
  toolName: "browser.click", actionHash: "a".repeat(64),
  risk: "medium" as const, status: "requested" as const, at: 100,
};

test("approval audit store recovers orphaned requests as interrupted, never actionable", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-approval-audit-"));
  try {
    const first = new FileApprovalAuditStore(directory);
    first.record(event);
    const restarted = new FileApprovalAuditStore(directory);
    assert.equal(restarted.recoverInterrupted(200), 1);
    assert.equal(restarted.recoverInterrupted(300), 0);
    const entries = restarted.list("owner-a");
    assert.deepEqual(entries.map((item) => item.status), ["interrupted", "requested"]);
    assert.equal(restarted.list("owner-b").length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("approval audit store rejects malformed events and bounds reads", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-approval-audit-"));
  try {
    const store = new FileApprovalAuditStore(directory);
    assert.throws(() => store.record({ ...event, actionHash: "bad" }));
    store.record(event);
    assert.equal(store.list("owner-a", 0).length, 0);
    assert.equal(store.list("owner-a", 501).length, 0);
    assert.equal(store.list("owner-a").length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
