import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Aes256GcmApprovalPayloadCipher } from "./approval-payload-cipher.js";
import { SqliteApprovalStore } from "./sqlite-approval-store.js";
import { SqliteApprovalPayloadStore } from "./sqlite-approval-payload-store.js";
import type { ApprovalAuditRecord } from "./approval.js";

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const supportsNodeSqlite = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5);

const record: ApprovalAuditRecord = {
  id: "approval-payload-1",
  runId: "run-payload-1",
  principalId: "tenant-payload-a",
  toolName: "browser.purchase",
  actionHash: "sha256-payload-action",
  risk: "high",
  status: "pending",
  createdAt: 1_000,
  expiresAt: 10_000,
};

const context = {
  approvalId: record.id,
  principalId: record.principalId,
  runId: record.runId,
  toolName: record.toolName,
  actionHash: record.actionHash,
  expiresAt: record.expiresAt,
};

test("SQLite approval payload store encrypts before persistence and decrypts only for the matching pending approval", {
  skip: !supportsNodeSqlite,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-approval-payload-"));
  const file = path.join(root, "approvals.sqlite");
  const metadata = await SqliteApprovalStore.open(file);
  const payloads = await SqliteApprovalPayloadStore.open(file);
  try {
    assert.equal(metadata.createPending(record), true);
    const cipher = new Aes256GcmApprovalPayloadCipher(randomBytes(32), "primary-v1");
    const secret = JSON.stringify({ paymentToken: "plaintext-must-never-hit-disk", item: "private purchase" });

    assert.equal(payloads.save(secret, context, cipher, 2_000), true);
    assert.equal(payloads.load(context, cipher, 2_001), secret);
    assert.equal(payloads.save(secret, context, cipher, 2_002), false);

    const wrongOwner = { ...context, principalId: "tenant-payload-b" };
    const wrongAction = { ...context, actionHash: "other-action" };
    assert.equal(payloads.load(wrongOwner, cipher, 2_001), null);
    assert.equal(payloads.save(secret, wrongAction, cipher, 2_001), false);
    assert.equal(payloads.load({ ...context, expiresAt: -1 }, cipher, 2_001), null);

    for (const diskFile of [file, file + "-wal", file + "-shm"]) {
      if (fs.existsSync(diskFile)) {
        assert.equal(fs.readFileSync(diskFile).includes(Buffer.from("plaintext-must-never-hit-disk")), false);
      }
    }
    assert.equal(metadata.settlePending(record.id, record.principalId, record.actionHash, "approved", 3_000), true);
    assert.equal(payloads.load(context, cipher, 3_001), secret); // The origin worker decrypts only after the decision is approved.
    assert.equal(payloads.delete(record.id), true);
    assert.equal(payloads.load(context, cipher, 3_001), null);
  } finally {
    payloads.close();
    metadata.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite approval payload store rejects oversized plaintext and invalid context", {
  skip: !supportsNodeSqlite,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-approval-payload-invalid-"));
  const file = path.join(root, "approvals.sqlite");
  const metadata = await SqliteApprovalStore.open(file);
  const payloads = await SqliteApprovalPayloadStore.open(file);
  try {
    assert.equal(metadata.createPending(record), true);
    const cipher = new Aes256GcmApprovalPayloadCipher(randomBytes(32), "primary-v1");
    assert.equal(payloads.save("x".repeat(300_000), context, cipher, 2_000), false);
    assert.equal(payloads.save("small", { ...context, expiresAt: -1 }, cipher, 2_000), false);
  } finally {
    payloads.close();
    metadata.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("atomic approval creation rolls back metadata when encryption fails", {
  skip: !supportsNodeSqlite,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-approval-atomic-"));
  const file = path.join(root, "approvals.sqlite");
  const metadata = await SqliteApprovalStore.open(file);
  const payloads = await SqliteApprovalPayloadStore.open(file);
  const brokenCipher = {
    encrypt() { throw new Error("simulated encryption failure"); },
    decrypt() { throw new Error("not used"); },
  };
  try {
    assert.equal(payloads.createPendingWithPayload(
      record, JSON.stringify({ private: true }), context, brokenCipher, 2_000,
    ), false);
    assert.deepEqual(metadata.history(record.principalId), []);
    assert.equal(payloads.load(context, new Aes256GcmApprovalPayloadCipher(randomBytes(32), "unused"), 2_001), null);
  } finally {
    payloads.close();
    metadata.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
