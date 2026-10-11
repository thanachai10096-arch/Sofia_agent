import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SecurityAuditEvent } from "../src/security/audit.js";
import { EncryptedFileAudit } from "../src/security/persistent-audit.js";

function event(id: string, input: unknown = { path: "src/app.ts" }): SecurityAuditEvent {
  return {
    id, at: new Date().toISOString(), runId: "run-1", principalId: "user-1",
    toolName: "workspace.write_file", actionHash: `hash-${id}`, risk: "medium",
    decision: "completed", input,
  };
}

describe("encrypted persistent audit", () => {
  it("survives a new sink instance and authenticates records", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sofia-audit-"));
    const file = path.join(directory, "audit", "events.log");
    try {
      const firstProcess = new EncryptedFileAudit(file, "test-audit-secret");
      await firstProcess.record(event("event-1"));
      await firstProcess.record(event("event-2", { command: "echo safe" }));

      // Simulate a process restart by constructing a fresh sink instance.
      const restartedProcess = new EncryptedFileAudit(file, "test-audit-secret");
      assert.deepEqual((await restartedProcess.list()).map((item) => item.id), ["event-1", "event-2"]);
      assert.equal((await restartedProcess.list())[1]?.input && JSON.stringify((await restartedProcess.list())[1]?.input), JSON.stringify({ command: "echo safe" }));

      const onDisk = await readFile(file, "utf8");
      assert.equal(onDisk.includes("echo safe"), false);
      assert.equal(onDisk.trim().split("\n").length, 2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when the secret is wrong or a record is tampered with", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sofia-audit-"));
    const file = path.join(directory, "events.log");
    try {
      await new EncryptedFileAudit(file, "correct-secret").record(event("event-1", { token: "hidden" }));
      await assert.rejects(() => new EncryptedFileAudit(file, "wrong-secret").list());
      const original = await readFile(file, "utf8");
      const payload = Buffer.from(original.trim(), "base64");
      payload[payload.length - 1] = (payload[payload.length - 1]! ^ 0xff);
      await writeFile(file, payload.toString("base64") + "\n", "utf8");
      await assert.rejects(() => new EncryptedFileAudit(file, "correct-secret").list());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns an empty list when no audit file exists and rejects an empty secret", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sofia-audit-"));
    try {
      const audit = new EncryptedFileAudit(path.join(directory, "missing.log"), "secret");
      assert.deepEqual(await audit.list(), []);
      await assert.rejects(() => new EncryptedFileAudit(path.join(directory, "empty.log"), "").record(event("event-1")), /secret is required/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("redacts credentials before persisting and returning audit records", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sofia-audit-"));
    const file = path.join(directory, "events.log");
    try {
      const audit = new EncryptedFileAudit(file, "test-audit-secret");
      await audit.record(event("event-secret", {
        api_key: "super-secret-value",
        authorization: "BearerToken123",
        note: "api_key=inline-secret",
        nested: { password: "nested-password" },
      }));
      const restored = (await new EncryptedFileAudit(file, "test-audit-secret").list())[0]!;
      assert.deepEqual(restored.input, {
        api_key: "[REDACTED]",
        authorization: "[REDACTED]",
        note: "api_key=[REDACTED]",
        nested: { password: "[REDACTED]" },
      });
      const onDisk = await readFile(file, "utf8");
      assert.equal(onDisk.includes("super-secret-value"), false);
      assert.equal(onDisk.includes("inline-secret"), false);
      assert.equal(onDisk.includes("nested-password"), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

});
