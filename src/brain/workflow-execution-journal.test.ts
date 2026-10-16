import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileWorkflowExecutionJournal } from "./workflow-execution-journal.js";

test("execution journal persists completed evidence and isolates principal namespaces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-workflow-journal-"));
  try {
    const first = new FileWorkflowExecutionJournal("principal-a", root);
    const second = new FileWorkflowExecutionJournal("principal-b", root);
    const actionHash = "a".repeat(64);
    await first.recordStarted({ workflowId: "workflow-1", stepId: "step-1", actionHash });
    assert.equal((await first.get("workflow-1", "step-1"))?.status, "started");
    await first.recordCompleted({ workflowId: "workflow-1", stepId: "step-1", actionHash, evidenceIds: ["evidence-1"] });
    assert.deepEqual((await first.get("workflow-1", "step-1"))?.evidenceIds, ["evidence-1"]);
    assert.equal((await second.get("workflow-1", "step-1")), undefined);
    await assert.rejects(
      () => first.recordStarted({ workflowId: "workflow-1", stepId: "step-1", actionHash }),
      /already exists/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("execution journal refuses completion or failure without matching started action hash", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-workflow-journal-"));
  try {
    const journal = new FileWorkflowExecutionJournal("principal", root);
    await assert.rejects(
      () => journal.recordCompleted({ workflowId: "w", stepId: "s", actionHash: "b".repeat(64), evidenceIds: [] }),
      /matching started journal entry/,
    );
    await journal.recordStarted({ workflowId: "w", stepId: "s", actionHash: "b".repeat(64) });
    await assert.rejects(
      () => journal.recordFailed({ workflowId: "w", stepId: "s", actionHash: "c".repeat(64), error: "mismatch" }),
      /matching started journal entry/,
    );
    await journal.recordFailed({ workflowId: "w", stepId: "s", actionHash: "b".repeat(64), error: "tool failed" });
    assert.equal((await journal.get("w", "s"))?.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
