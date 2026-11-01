import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  advanceRestoreJournal,
  createRestoreJournalRecord,
  FileRestoreJournalStore,
  validateRestoreJournalRecord,
} from "./restore-journal.js";

const rootRecord = (transactionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa") => createRestoreJournalRecord({
  transactionId,
  createdAt: "2026-11-01T08:00:00.000Z",
  manifestSha256: "a".repeat(64),
  targets: [
    { name: "sessions", paths: ["sessions/snapshot.sqlite"], rollbackSnapshotRef: "snapshots/sessions-before" },
    { name: "memory", paths: ["memory/project.json"], rollbackSnapshotRef: "snapshots/memory-before" },
  ],
});

test("restore journal persists immutable revisions and recovers latest state after a new store instance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-restore-journal-"));
  try {
    const firstStore = new FileRestoreJournalStore(root);
    const initial = rootRecord();
    await firstStore.create(initial);

    const applying = advanceRestoreJournal(initial, {
      phase: "applying",
      updatedAt: "2026-11-01T08:00:01.000Z",
      targets: initial.targets.map((target, index) => ({
        ...target,
        phase: index === 0 ? "applied" : "applying",
      })),
    });
    await firstStore.append(applying, initial.revision);

    const recovered = await new FileRestoreJournalStore(root).read(initial.transactionId);
    assert.deepEqual(recovered, applying);
    assert.equal((await readdir(path.join(root, (await readdir(root))[0]!))).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore journal append rejects stale revisions without overwriting prior records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-restore-journal-stale-"));
  try {
    const store = new FileRestoreJournalStore(root);
    const initial = rootRecord();
    await store.create(initial);
    const next = advanceRestoreJournal(initial, {
      phase: "applying",
      updatedAt: "2026-11-01T08:00:01.000Z",
    });
    await store.append(next, 0);
    await assert.rejects(store.append(next, 0), /revision conflict/i);
    assert.deepEqual(await store.read(initial.transactionId), next);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore journal refuses illegal terminal transitions and target ownership changes", () => {
  const initial = rootRecord();
  const committed = advanceRestoreJournal(initial, {
    phase: "applying",
    updatedAt: "2026-11-01T08:00:01.000Z",
  });
  const terminal = advanceRestoreJournal(committed, {
    phase: "committed",
    updatedAt: "2026-11-01T08:00:02.000Z",
  });
  assert.throws(() => advanceRestoreJournal(terminal, {
    phase: "rollback_required",
    updatedAt: "2026-11-01T08:00:03.000Z",
  }), /terminal/i);
  assert.throws(() => advanceRestoreJournal(initial, {
    phase: "applying",
    updatedAt: "2026-11-01T08:00:01.000Z",
    targets: [{ ...initial.targets[0]!, name: "renamed-target" }, initial.targets[1]!],
  }), /ownership is immutable/i);
});

test("restore journal rejects unsafe paths, malformed digests, and unknown fields in state values", () => {
  const initial = rootRecord();
  assert.throws(() => validateRestoreJournalRecord({
    ...initial,
    manifestSha256: "not-a-hash",
  }), /digest/i);
  assert.throws(() => validateRestoreJournalRecord({
    ...initial,
    targets: [{ ...initial.targets[0]!, paths: ["../../secrets.env"] }, initial.targets[1]],
  }), /unsafe target path/i);
  assert.throws(() => validateRestoreJournalRecord({
    ...initial,
    targets: [{ ...initial.targets[0]!, paths: ["C:/private/secret.json"] }, initial.targets[1]],
  }), /unsafe target path/i);
});

test("restore journal files and directories use private permissions on POSIX", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX permission bits are not available on Windows");
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-restore-journal-mode-"));
  try {
    const store = new FileRestoreJournalStore(root);
    const initial = rootRecord();
    await store.create(initial);
    const directory = path.join(root, (await readdir(root))[0]!);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, "0000000000.json"))).mode & 0o777, 0o600);
    assert.equal((await readFile(path.join(directory, "0000000000.json"), "utf8")).includes("snapshot contents"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore journal list returns the latest revision for every transaction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-restore-journal-list-"));
  try {
    const store = new FileRestoreJournalStore(root);
    const first = rootRecord("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    const second = rootRecord("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    await store.create(first);
    await store.create(second);
    const next = advanceRestoreJournal(first, {
      phase: "rollback_required",
      updatedAt: "2026-11-01T08:00:01.000Z",
    });
    await store.append(next, 0);
    const records = await store.list();
    assert.deepEqual(records.map((record) => [record.transactionId, record.revision]), [
      [first.transactionId, 1],
      [second.transactionId, 0],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
