import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  advanceRestoreJournal,
  createRestoreJournalRecord,
  FileRestoreJournalStore,
  type RestoreJournalRecord,
  type RestoreJournalStore,
} from "./restore-journal.js";
import { recoverInterruptedRestoreTransaction, scanRestoreRecovery } from "./restore-recovery.js";
import { directoryBackupRestoreAdapter } from "./file-backup-restore-adapter.js";
import { FileRestoreSnapshotStore } from "./restore-snapshot-store.js";

const makeRecord = (transactionId: string): RestoreJournalRecord => createRestoreJournalRecord({
  transactionId,
  createdAt: "2026-11-03T00:00:00.000Z",
  manifestSha256: "a".repeat(64),
  targets: [
    { name: "sessions", paths: ["sessions/db.sqlite"], rollbackSnapshotRef: "snapshots/sessions" },
    { name: "memory", paths: ["memory/project.json"], rollbackSnapshotRef: "snapshots/memory" },
  ],
});

function storeWith(records: RestoreJournalRecord[]): RestoreJournalStore {
  return {
    async create() { throw new Error("read-only test store"); },
    async append() { throw new Error("read-only test store"); },
    async read() { return undefined; },
    async list() { return records; },
  };
}

test("recovery scanner classifies terminal and interrupted intents without mutation", async () => {
  const prepared = makeRecord("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  const applying = advanceRestoreJournal(prepared, {
    phase: "applying",
    updatedAt: "2026-11-03T00:00:01.000Z",
    targets: prepared.targets.map((target, index) => ({ ...target, phase: index === 0 ? "applied" : "applying" })),
  });
  const rollbackRequired = advanceRestoreJournal(applying, {
    phase: "rollback_required",
    updatedAt: "2026-11-03T00:00:02.000Z",
  });
  const rolling = advanceRestoreJournal(rollbackRequired, {
    phase: "rolling_back",
    updatedAt: "2026-11-03T00:00:03.000Z",
  });
  const rolledBack = advanceRestoreJournal(rolling, {
    phase: "rolled_back",
    updatedAt: "2026-11-03T00:00:04.000Z",
    targets: rolling.targets.map((target) => ({ ...target, phase: "rolled_back" })),
  });

  const report = await scanRestoreRecovery(storeWith([applying, prepared, rolledBack]), "2026-11-03T00:01:00.000Z");
  assert.equal(report.total, 3);
  assert.equal(report.rolledBack, 1);
  assert.equal(report.completed, 0);
  assert.equal(report.needsRecovery, 2);
  assert.deepEqual(report.items.map((item) => item.disposition), [
    "interrupted_before_apply",
    "interrupted_during_apply",
    "rolled_back",
  ]);
  assert.deepEqual(report.items[1]?.appliedTargets, ["sessions"]);
  assert.deepEqual(report.items[1]?.pendingTargets, ["memory"]);
});

test("recovery scanner marks failed rollback for operator recovery", async () => {
  const initial = makeRecord("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  const applying = advanceRestoreJournal(initial, {
    phase: "applying",
    updatedAt: "2026-11-03T00:00:01.000Z",
  });
  const required = advanceRestoreJournal(applying, {
    phase: "rollback_required",
    updatedAt: "2026-11-03T00:00:02.000Z",
    failureCode: "adapter_apply_failed",
  });
  const failed = advanceRestoreJournal(required, {
    phase: "rollback_failed",
    updatedAt: "2026-11-03T00:00:03.000Z",
    failureCode: "rollback_incomplete",
    targets: required.targets.map((target, index) => ({
      ...target,
      phase: index === 0 ? "rollback_failed" : "rollback_pending",
    })),
  });
  const report = await scanRestoreRecovery(storeWith([failed]), "2026-11-03T00:01:00.000Z");
  assert.equal(report.needsRecovery, 1);
  assert.equal(report.items[0]?.disposition, "manual_recovery_required");
  assert.equal(report.items[0]?.requiresOperatorReview, true);
  assert.equal(report.items[0]?.failureCode, "rollback_incomplete");
});

test("recovery scanner rejects invalid timestamps and malformed journal records", async () => {
  await assert.rejects(scanRestoreRecovery(storeWith([]), "not-a-date"), /canonical ISO-8601/i);
  await assert.rejects(scanRestoreRecovery(storeWith([{} as RestoreJournalRecord])), /format or version/i);
});


test("startup recovery restores an interrupted file target from a verified durable snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-restore-recovery-e2e-"));
  const transactionId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  try {
    const destinationRoot = path.join(root, "destination");
    await mkdir(destinationRoot);
    const destination = path.join(destinationRoot, "state.json");
    await writeFile(destination, "before");
    const adapter = directoryBackupRestoreAdapter("state", destinationRoot, ["state.json"]);
    const snapshotStore = new FileRestoreSnapshotStore(path.join(root, "snapshots"));
    const journal = new FileRestoreJournalStore(path.join(root, "journal"));

    const inMemory = await adapter.captureRollback();
    const encoded = adapter.serializeRollbackSnapshot!(inMemory);
    const persisted = await snapshotStore.write(transactionId, "state", encoded);
    const prepared = createRestoreJournalRecord({
      transactionId,
      createdAt: "2026-11-03T00:00:00.000Z",
      manifestSha256: "c".repeat(64),
      targets: [{
        name: "state",
        paths: ["state.json"],
        rollbackSnapshotRef: persisted.ref,
        rollbackSnapshotSha256: persisted.sha256,
      }],
    });
    await journal.create(prepared);
    const interrupted = advanceRestoreJournal(prepared, {
      phase: "applying",
      updatedAt: "2026-11-03T00:00:01.000Z",
      targets: prepared.targets.map((target) => ({ ...target, phase: "applying" })),
    });
    await journal.append(interrupted, prepared.revision);
    await writeFile(destination, "partially-restored");

    const recovered = await recoverInterruptedRestoreTransaction({
      transactionId,
      journal,
      snapshotStore,
      adapters: [{
        name: adapter.name,
        paths: adapter.paths,
        rollbackFromSnapshotBytes: adapter.rollbackFromSnapshotBytes!,
      }],
      async withExclusiveLock(_id, operation) { return operation(); },
    });

    assert.equal(recovered.phase, "rolled_back");
    assert.equal(recovered.targets[0]?.phase, "rolled_back");
    assert.equal(await readFile(destination, "utf8"), "before");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup recovery refuses to run without the caller's exclusive lock", async () => {
  await assert.rejects(recoverInterruptedRestoreTransaction({
    transactionId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    journal: storeWith([]),
    snapshotStore: new FileRestoreSnapshotStore("/tmp/sofia-unused-snapshot-store"),
    adapters: [],
    withExclusiveLock: undefined as never,
  }), /exclusive lock/i);
});
