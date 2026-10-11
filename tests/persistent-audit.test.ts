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
