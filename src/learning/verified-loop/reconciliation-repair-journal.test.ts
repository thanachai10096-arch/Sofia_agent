import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteLearningRepairJournal } from "./reconciliation-repair-executor.js";
import type { LearningScope } from "./ports.js";

const scope: LearningScope = { tenantId: "tenant-a", principalId: "user-a", projectId: "project-a" };

test("repair journal persists idempotency state and audit events across reopen", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-repair-journal-"));
  const file = path.join(dir, "repair.sqlite");
  try {
    let journal = await SqliteLearningRepairJournal.open(file);
    const entry = await journal.begin({
      key: "repair-1", scope, skillId: "skill-1", policyRevision: "policy-1",
      state: "running", attempts: 0, updatedAt: "2026-10-29T00:00:00.000Z",
    });
    assert.equal(entry.attempts, 1);
    await journal.audit({
      key: "repair-1", scope, actorId: "operator-1", skillId: "skill-1",
      event: "repair_started", at: "2026-10-29T00:00:01.000Z",
    });
    await journal.finish("repair-1", scope, "succeeded", "verified");
    journal.close();

    journal = await SqliteLearningRepairJournal.open(file);
    const restored = await journal.get("repair-1", scope);
    assert.equal(restored?.state, "succeeded");
    assert.equal(restored?.result, "verified");
    const replay = await journal.begin({
      key: "repair-1", scope, skillId: "skill-1", policyRevision: "policy-1",
      state: "running", attempts: 0, updatedAt: "2026-10-29T00:00:02.000Z",
    });
    assert.equal(replay.state, "succeeded");
    await assert.rejects(() => journal.get("repair-1", { ...scope, tenantId: "tenant-b" }), /Cross-scope/);
    journal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("repair journal refuses idempotency-key reuse for another skill or policy", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-repair-journal-"));
  const journal = await SqliteLearningRepairJournal.open(path.join(dir, "repair.sqlite"));
  try {
    await journal.begin({
      key: "repair-1", scope, skillId: "skill-1", policyRevision: "policy-1",
      state: "running", attempts: 0, updatedAt: "2026-10-29T00:00:00.000Z",
    });
    await assert.rejects(() => journal.begin({
      key: "repair-1", scope, skillId: "skill-2", policyRevision: "policy-1",
      state: "running", attempts: 0, updatedAt: "2026-10-29T00:00:01.000Z",
    }), /conflicts/);
  } finally {
    journal.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("repair audit journal rejects malformed events and prevents update/delete", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-repair-journal-"));
  const journal = await SqliteLearningRepairJournal.open(path.join(dir, "repair.sqlite"));
  try {
    assert.throws(() => journal.audit({
      key: "repair-1", scope, actorId: "", skillId: "skill-1",
      event: "repair_started", at: "not-a-date",
    }), /Invalid learning repair audit event/);
    assert.throws(() => journal.audit(null as never), /Invalid learning repair audit event/);
    assert.throws(() => journal.audit({
      key: "repair-1", scope, actorId: "operator-1", skillId: "skill-1",
      event: "repair_started", at: "2026-10-29T00:00:01.000Z", detail: 42 as never,
    }), /Invalid learning repair audit event/);
    await journal.audit({
      key: "repair-1", scope, actorId: "operator-1", skillId: "skill-1",
      event: "repair_started", at: "2026-10-29T00:00:01.000Z",
    });
    const dbModule = await import("node:sqlite");
    const db = new dbModule.DatabaseSync(path.join(dir, "repair.sqlite"));
    try {
      assert.throws(() => db.exec("UPDATE learning_repair_audit SET detail='tampered'"), /append-only/);
      assert.throws(() => db.exec("DELETE FROM learning_repair_audit"), /append-only/);
    } finally {
      db.close();
    }
  } finally {
    journal.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite journal atomically refuses a second executor claiming a running repair", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-repair-journal-"));
  const file = path.join(dir, "repair.sqlite");
  const first = await SqliteLearningRepairJournal.open(file);
  const second = await SqliteLearningRepairJournal.open(file);
  const entry = {
    key: "repair-concurrent", scope, skillId: "skill-concurrent", policyRevision: "policy-1",
    state: "running" as const, attempts: 0, updatedAt: "2026-10-29T00:00:00.000Z",
  };
  try {
    const owner = await first.begin(entry);
    assert.equal(owner.claimed, true);
    const contender = await second.begin({ ...entry, updatedAt: "2026-10-29T00:00:01.000Z" });
    assert.equal(contender.claimed, false);
    assert.equal(contender.state, "running");
    assert.equal(contender.attempts, 1);
    assert.equal((await first.get(entry.key, scope))?.attempts, 1);
  } finally {
    first.close();
    second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
