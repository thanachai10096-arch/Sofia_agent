import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBackupBundle, executeBackupRestoreTransaction } from "./backup-coordinator.js";
import { directoryBackupRestoreAdapter } from "./file-backup-restore-adapter.js";

const createdAt = "2026-10-29T04:00:00.000Z";

test("directory restore adapter atomically applies verified files and restores prior bytes", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sofia-file-restore-"));
  const root = path.join(parent, "root");
  await mkdir(path.join(root, "memory"), { recursive: true });
  const destination = path.join(root, "memory", "entry.json");
  await writeFile(destination, '{"old":true}', { mode: 0o600 });
  try {
    const bundle = await createBackupBundle([{
      name: "memory",
      async snapshot() { return [{ path: "memory/entry.json", content: Buffer.from('{"new":true}') }]; },
    }], createdAt);
    const adapter = directoryBackupRestoreAdapter("project-memory", root, ["memory/entry.json"]);
    await adapter.preflight(bundle, ["memory/entry.json"]);
    const snapshot = await adapter.captureRollback();
    await adapter.apply(bundle, ["memory/entry.json"]);
    assert.equal(await readFile(destination, "utf8"), '{"new":true}');
    await adapter.rollback(snapshot);
    assert.equal(await readFile(destination, "utf8"), '{"old":true}');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("directory restore adapter removes newly-created files when rollback runs", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sofia-file-restore-"));
  const root = path.join(parent, "root");
  await mkdir(root);
  try {
    const bundle = await createBackupBundle([{
      name: "memory",
      async snapshot() { return [{ path: "memory/new.json", content: Buffer.from("{}") }]; },
    }], createdAt);
    const adapter = directoryBackupRestoreAdapter("memory", root, ["memory/new.json"]);
    const snapshot = await adapter.captureRollback();
    await adapter.apply(bundle, ["memory/new.json"]);
    await adapter.rollback(snapshot);
    await assert.rejects(readFile(path.join(root, "memory", "new.json")), { code: "ENOENT" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("directory restore adapter rejects symlinked destination parents before writes", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sofia-file-restore-"));
  const root = path.join(parent, "root");
  const outside = path.join(parent, "outside");
  await mkdir(root);
  await mkdir(outside);
  await symlink(outside, path.join(root, "memory"));
  try {
    const bundle = await createBackupBundle([{
      name: "memory",
      async snapshot() { return [{ path: "memory/entry.json", content: Buffer.from("{}") }]; },
    }], createdAt);
    const adapter = directoryBackupRestoreAdapter("a-memory", root, ["memory/entry.json"]);
    await assert.rejects(adapter.preflight(bundle, ["memory/entry.json"]), /symbolic links/);
    await assert.rejects(readFile(path.join(outside, "entry.json")), { code: "ENOENT" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("directory adapter participates in transaction rollback when a later target fails", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sofia-file-restore-"));
  const root = path.join(parent, "root");
  await mkdir(root);
  const destination = path.join(root, "memory", "entry.json");
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, "before");
  try {
    const bundle = await createBackupBundle([{
      name: "state",
      async snapshot() {
        return [
          { path: "memory/entry.json", content: Buffer.from("after") },
          { path: "other/fail.json", content: Buffer.from("fail") },
        ];
      },
    }], createdAt);
    const fileAdapter = directoryBackupRestoreAdapter("memory", root, ["memory/entry.json"]);
    const failingAdapter = {
      name: "z-later",
      paths: ["other/fail.json"],
      async preflight() {},
      async captureRollback() { return null; },
      async apply() { throw new Error("simulated later target failure"); },
      async rollback() {},
    };
    await assert.rejects(executeBackupRestoreTransaction(bundle, [fileAdapter, failingAdapter]), /simulated later target failure/);
    assert.equal(await readFile(destination, "utf8"), "before");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
