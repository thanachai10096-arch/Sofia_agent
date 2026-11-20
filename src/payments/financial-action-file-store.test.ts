import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileFinancialActionStore, FileFinancialLedger } from "./financial-action-file-store.js";
import type { FinancialActionRecord } from "./financial-actions.js";

function record(): FinancialActionRecord { return { id: "123e4567-e89b-12d3-a456-426614174000", ownerId: "acct-a", idempotencyHash: "a".repeat(64), requestFingerprint: "b".repeat(64), orderReference: "ORDER-1", amountMinor: 100, currency: "THB", status: "submitting", createdAt: "2026-11-20T10:00:00.000Z", updatedAt: "2026-11-20T10:00:00.000Z", approvalId: "approval-1", reason: "reserved" }; }
test("persists action reservations across store instances and rejects duplicate reservation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sofia-financial-"));
  try { const first = new FileFinancialActionStore(dir), second = new FileFinancialActionStore(dir);
    assert.equal((await first.reserve(record())).created, true);
    const duplicate = await second.reserve(record()); assert.equal(duplicate.created, false); assert.equal(duplicate.record.id, record().id);
    assert.equal((await new FileFinancialActionStore(dir).find("acct-a", "a".repeat(64)))?.status, "submitting");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("atomically updates a reserved action and rejects unknown records", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sofia-financial-"));
  try { const store = new FileFinancialActionStore(dir); await store.reserve(record());
    const updated = { ...record(), status: "succeeded" as const, updatedAt: "2026-11-20T10:01:00.000Z" }; await store.update(updated);
    assert.equal((await store.find("acct-a", "a".repeat(64)))?.status, "succeeded");
    await assert.rejects(store.update({ ...updated, id: "123e4567-e89b-12d3-a456-426614174001" }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("rejects changes to transaction terms after reservation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sofia-financial-"));
  try { const store = new FileFinancialActionStore(dir); await store.reserve(record());
    await assert.rejects(store.update({ ...record(), amountMinor: 999 }), /immutable/);
    assert.equal((await store.find("acct-a", "a".repeat(64)))?.amountMinor, 100);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("prevents terminal payment status from being downgraded", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sofia-financial-"));
  try { const store = new FileFinancialActionStore(dir); await store.reserve(record());
    const succeeded = { ...record(), status: "succeeded" as const, updatedAt: "2026-11-20T10:01:00.000Z" };
    await store.update(succeeded);
    await assert.rejects(store.update({ ...succeeded, status: "processing", updatedAt: "2026-11-20T10:02:00.000Z" }), /Terminal/);
    assert.equal((await store.find("acct-a", "a".repeat(64)))?.status, "succeeded");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("appends immutable JSONL audit events", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sofia-ledger-")), filename = path.join(dir, "audit", "payments.jsonl");
  try { const ledger = new FileFinancialLedger(filename); const event = { id: "123e4567-e89b-12d3-a456-426614174000", actionId: "123e4567-e89b-12d3-a456-426614174001", type: "prepared" as const, occurredAt: "2026-11-20T10:00:00.000Z", details: { amountMinor: 100 } };
    await ledger.append(event); await ledger.append({ ...event, id: "123e4567-e89b-12d3-a456-426614174002", type: "submitted" });
    const lines = (await readFile(filename, "utf8")).trim().split("\n"); assert.equal(lines.length, 2); assert.equal(JSON.parse(lines[0]!).type, "prepared"); assert.equal(JSON.parse(lines[1]!).type, "submitted");
  } finally { await rm(dir, { recursive: true, force: true }); }
});