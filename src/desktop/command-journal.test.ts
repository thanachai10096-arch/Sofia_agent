import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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
