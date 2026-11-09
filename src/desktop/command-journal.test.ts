import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileDesktopCommandJournal } from "./command-journal.js";

test("file journal survives restart and replays only a durably completed outcome", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-command-journal-"));
  const id = "00000000-0000-4000-8000-000000000001";
  try {
    const firstProcess = new FileDesktopCommandJournal(directory);
    await firstProcess.begin(id);
    const restartedProcess = new FileDesktopCommandJournal(directory);
    const recovered = await restartedProcess.get(id);
    assert.equal(recovered?.status, "started");
    assert.equal(recovered?.commandId, id);
    await assert.rejects(restartedProcess.begin(id), /already exists/);
    await restartedProcess.complete(id, { result: { ok: true } });
    const thirdProcess = new FileDesktopCommandJournal(directory);
    assert.deepEqual((await thirdProcess.get(id))?.status, "completed");
    assert.deepEqual((await thirdProcess.get(id))?.status === "completed"
      ? (await thirdProcess.get(id) as { outcome: unknown }).outcome : null, { result: { ok: true } });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("two Companion processes cannot both begin the same command", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-command-journal-race-"));
  const id = "00000000-0000-4000-8000-000000000002";
  try {
    const first = new FileDesktopCommandJournal(directory);
    const second = new FileDesktopCommandJournal(directory);
    const results = await Promise.allSettled([first.begin(id), second.begin(id)]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(results.filter((item) => item.status === "rejected").length, 1);
    assert.equal((await first.get(id))?.status, "started");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("journal prunes only old completed records and retains indeterminate started records", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-command-journal-retention-"));
  const completedId = "00000000-0000-4000-8000-000000000003";
  const startedId = "00000000-0000-4000-8000-000000000004";
  try {
    const journal = new FileDesktopCommandJournal(directory);
    await journal.begin(completedId);
    await journal.complete(completedId, { result: { ok: true } });
    await journal.begin(startedId);
    const old = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
    const completedPath = path.join(directory, readdirSync(directory).find((name) => name.endsWith(".json") &&
      JSON.parse(readFileSync(path.join(directory, name), "utf8")).commandId === completedId)!);
    utimesSync(completedPath, old, old);
    await journal.begin("00000000-0000-4000-8000-000000000005");
    assert.equal(await journal.get(completedId), null);
    assert.equal((await journal.get(startedId))?.status, "started");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("file journal refuses to follow a symlink as its journal directory", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sofia-command-journal-link-"));
  const target = path.join(root, "target");
  const link = path.join(root, "link");
  try {
    // The target is created first; the journal constructor must reject the link itself.
    mkdirSync(target);
    symlinkSync(target, link, "dir");
    assert.throws(() => new FileDesktopCommandJournal(link), /real directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
