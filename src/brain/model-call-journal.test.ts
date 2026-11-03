import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteModelCallJournal, type ModelCallIdentity } from "./model-call-journal.js";

function identity(overrides: Partial<ModelCallIdentity> = {}): ModelCallIdentity {
  return {
    idempotencyKey: "run-1:plan:attempt-1",
    runId: "run-1",
    phase: "plan",
    providerId: "openai-compatible",
    modelId: "test-model",
    attempt: 1,
    reservedInputTokens: 100,
    reservedOutputTokens: 200,
    ...overrides,
  };
}

async function temporaryJournal() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-model-journal-"));
  const file = path.join(directory, "journal.sqlite");
  return {
    file,
    cleanup() { fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

test("journal commits dispatch before provider I/O and suppresses duplicate dispatch", async () => {
  const temp = await temporaryJournal();
  const first = await SqliteModelCallJournal.open(temp.file);
  const second = await SqliteModelCallJournal.open(temp.file);
  try {
    const a = first.beginDispatch(identity(), 100);
    const b = second.beginDispatch(identity(), 101);
    assert.equal(a.shouldDispatch, true);
    assert.equal(a.entry.state, "dispatched");
    assert.equal(b.shouldDispatch, false);
    assert.equal(b.entry.dispatchedAt, 100);
    assert.equal(first.listByRun("run-1").length, 1);
  } finally {
    first.close();
    second.close();
    temp.cleanup();
  }
});

test("journal rejects reuse of an idempotency key for a different call", async () => {
  const temp = await temporaryJournal();
  const journal = await SqliteModelCallJournal.open(temp.file);
  try {
    journal.beginDispatch(identity(), 100);
    assert.throws(
      () => journal.beginDispatch(identity({ modelId: "different-model" }), 101),
      /different model call/,
    );
  } finally {
    journal.close();
    temp.cleanup();
  }
});

test("settlement is durable and idempotent but conflicting evidence is rejected", async () => {
  const temp = await temporaryJournal();
  const journal = await SqliteModelCallJournal.open(temp.file);
  try {
    journal.beginDispatch(identity(), 100);
    const evidence = { inputTokens: 80, outputTokens: 20, costNanoUsd: 1234n };
    const first = journal.settle(identity().idempotencyKey, evidence, 200);
    const second = journal.settle(identity().idempotencyKey, evidence, 201);
    assert.equal(first.state, "settled");
    assert.equal(first.costNanoUsd, "1234");
    assert.deepEqual(second, first);
    assert.throws(
      () => journal.settle(identity().idempotencyKey, { ...evidence, costNanoUsd: 1235n }, 202),
      /Conflicting settlement evidence/,
    );
  } finally {
    journal.close();
    temp.cleanup();
  }
});

test("unresolved dispatch survives restart as indeterminate and is not redispatched", async () => {
  const temp = await temporaryJournal();
  const first = await SqliteModelCallJournal.open(temp.file);
  first.beginDispatch(identity(), 100);
  first.close();

  const recovered = await SqliteModelCallJournal.open(temp.file);
  try {
    assert.equal(recovered.get(identity().idempotencyKey)?.state, "dispatched");
    const indeterminate = recovered.markIndeterminate(identity().idempotencyKey);
    assert.equal(indeterminate.state, "indeterminate");
    const retry = recovered.beginDispatch(identity(), 300);
    assert.equal(retry.shouldDispatch, false);
    assert.equal(retry.entry.state, "indeterminate");
  } finally {
    recovered.close();
    temp.cleanup();
  }
});

test("journal validates usage, cost, timestamps and query bounds", async () => {
  const temp = await temporaryJournal();
  const journal = await SqliteModelCallJournal.open(temp.file);
  try {
    journal.beginDispatch(identity(), 100);
    assert.throws(
      () => journal.settle(identity().idempotencyKey, { inputTokens: -1, outputTokens: 0, costNanoUsd: 1n }),
      /Invalid model call settlement/,
    );
    assert.throws(
      () => journal.listByRun("run-1", 1001),
      /Invalid journal query/,
    );
    assert.equal(journal.get(identity().idempotencyKey)?.state, "dispatched");
  } finally {
    journal.close();
    temp.cleanup();
  }
});
