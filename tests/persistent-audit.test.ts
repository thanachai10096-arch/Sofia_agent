import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SecurityAuditEvent } from "../src/security/audit.js";
import { EncryptedFileAudit } from "../src/security/persistent-audit.js";

function makeEvent(id: string, input: unknown = { path: "src/app.ts" }): SecurityAuditEvent {
  return {
    id, at: new Date().toISOString(), runId: "run-1", principalId: "user-1",
    toolName: "workspace.write_file", actionHash: `hash-${id}`, risk: "medium",
    decision: "completed", input,
  };
}

describe("encrypted persistent audit", () => {
  it("survives a fresh sink instance and does not store plaintext", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sofia-audit-"));
    const file = path.join(directory, "audit", "events.log");
    try {
      const originalProcess = new EncryptedFileAudit(file, "test-audit-secret");
      await originalProcess.record(makeEvent("event-1"));
      await originalProcess.record(makeEvent("event-2", { command: "echo safe" }));
      const restartedProcess = new EncryptedFileAudit(file, "test-audit-secret");
      const events = await restartedProcess.list();
      assert.deepEqual(events.map((item) => item.id), ["event-1", "event-2"]);
      assert.deepEqual(events[1]?.input, { command: "echo safe" });
      const onDisk = await readFile(file, "utf8");
      assert.equal(onDisk.includes("echo safe"), false);
      assert.equal(onDisk.trim().split("\n").length, 2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retrieves only completed evidence by its durable evidence ID after restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sofia-evidence-"));
    const file = path.join(directory, "events.log");
    try {
      const first = new EncryptedFileAudit(file, "evidence-audit-secret");
      await first.record({
        ...makeEvent("event-start"),
        decision: "execution_started",
        operationId: "operation-evidence",
        evidenceId: "evidence-123",
      });
      await first.record({
        ...makeEvent("event-complete"),
        decision: "completed",
        operationId: "operation-evidence",
        evidenceId: "evidence-123",
        result: { output: "verified" },
      });
      const restarted = new EncryptedFileAudit(file, "evidence-audit-secret");
      const evidence = await restarted.getEvidence("evidence-123");
      assert.equal(evidence?.decision, "completed");
      assert.equal(evidence?.operationId, "operation-evidence");
      assert.deepEqual(evidence?.result, { output: "verified" });
      assert.equal(await restarted.getEvidence("missing"), undefined);
      assert.equal(await restarted.getEvidence(""), undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent appends into independently readable encrypted records", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sofia-audit-concurrent-"));
    const file = path.join(directory, "events.log");
    try {
      const audit = new EncryptedFileAudit(file, "concurrent-audit-secret");
      const ids = Array.from({ length: 64 }, (_, index) => `event-${index}`);
      await Promise.all(ids.map((id) => audit.record(makeEvent(id))));
      const events = await audit.list();
      assert.equal(events.length, ids.length);
      assert.deepEqual(new Set(events.map((event) => event.id)), new Set(ids));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes appends from multiple sink instances targeting the same file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sofia-audit-multi-instance-"));
    const file = path.join(directory, "events.log");
    try {
      const first = new EncryptedFileAudit(file, "shared-audit-secret");
      const second = new EncryptedFileAudit(file, "shared-audit-secret");
      const ids = Array.from({ length: 64 }, (_, index) => `instance-event-${index}`);
      await Promise.all(ids.map((id, index) =>
        (index % 2 === 0 ? first : second).record(makeEvent(id)),
      ));
      const events = await first.list();
      assert.equal(events.length, ids.length);
      assert.deepEqual(new Set(events.map((event) => event.id)), new Set(ids));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports started executions without terminal outcomes for crash reconciliation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sofia-audit-recovery-"));
    const file = path.join(directory, "events.log");
    try {
      const audit = new EncryptedFileAudit(file, "recovery-audit-secret");
      const started = makeEvent("start-1");
      await audit.record({ ...started, id: "event-start-1", decision: "execution_started", operationId: "operation-1" });
      await audit.record({ ...started, id: "event-start-2", decision: "execution_started", operationId: "operation-2" });
      await audit.record({ ...started, id: "event-complete-2", decision: "completed", operationId: "operation-2" });
      await audit.record({ ...started, id: "event-start-3", decision: "execution_started", operationId: "operation-3" });
      await audit.record({ ...started, id: "event-failed-3", decision: "failed", operationId: "operation-3", reason: "partial write possible" });
      const incomplete = await audit.listIncompleteExecutions();
      assert.equal(incomplete.length, 2);
      assert.equal(incomplete[0]?.operationId, "operation-1");
      assert.equal(incomplete[0]?.started.decision, "execution_started");
      assert.equal(incomplete[1]?.operationId, "operation-3");
      assert.equal(incomplete[1]?.latest?.decision, "failed", "failed tools may have partial side effects and require reconciliation");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects wrong keys and tampered ciphertext", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sofia-audit-"));
    const file = path.join(directory, "events.log");
    try {
      await new EncryptedFileAudit(file, "correct-secret").record(makeEvent("event-1"));
      await assert.rejects(() => new EncryptedFileAudit(file, "wrong-secret").list());
      const payload = Buffer.from((await readFile(file, "utf8")).trim(), "base64");
      payload[payload.length - 1] = payload[payload.length - 1]! ^ 0xff;
      await writeFile(file, payload.toString("base64") + "\n", "utf8");
      await assert.rejects(() => new EncryptedFileAudit(file, "correct-secret").list());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns no events for a missing file and rejects an empty secret", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sofia-audit-"));
    try {
      assert.deepEqual(await new EncryptedFileAudit(path.join(directory, "missing.log"), "secret").list(), []);
      await assert.rejects(
        () => new EncryptedFileAudit(path.join(directory, "empty.log"), "").record(makeEvent("event-1")),
        /secret is required/i,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
