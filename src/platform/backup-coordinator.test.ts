import test from "node:test";
import assert from "node:assert/strict";
import { createBackupBundle, projectMemoryBackupSource, userMemoryBackupSource, verifyBackupBundle } from "./backup-coordinator.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileProjectMemoryStore, memoryEntryFromConvention } from "../brain/project-memory.js";
import { FileUserMemoryStore, createUserMemoryEntry } from "../brain/user-memory.js";

const createdAt = "2026-10-29T04:00:00.000Z";

test("backup coordinator snapshots sources sequentially and verifies the returned bundle", async () => {
  const order: string[] = [];
  const bundle = await createBackupBundle([
    { name: "sessions", async snapshot() { order.push("sessions"); return [{ path: "sessions/snapshot.sqlite", content: Buffer.from("session data") }]; } },
    { name: "memory", async snapshot() { order.push("memory"); return [{ path: "memory/user.json", content: Buffer.from("{}") }]; } },
  ], createdAt);

  assert.deepEqual(order, ["sessions", "memory"]);
  assert.equal(bundle.manifest.entries.length, 2);
  assert.equal(verifyBackupBundle(bundle).valid, true);
});

test("project-memory source includes only the explicit store snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-backup-memory-source-"));
  try {
    const store = new FileProjectMemoryStore("backup-source-project", root);
    const source = projectMemoryBackupSource(store);
    assert.deepEqual(await source.snapshot(), []);
    await store.save(memoryEntryFromConvention("backup-source-project", "Backup-safe memory record"));
    const bundle = await createBackupBundle([source], createdAt);
    assert.equal(bundle.manifest.entries.length, 1);
    assert.match(bundle.manifest.entries[0]!.path, /^memory\/[a-f0-9]{64}\.json$/u);
    assert.equal(verifyBackupBundle(bundle).valid, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user-memory backup source snapshots only the explicitly selected user's file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-backup-user-memory-"));
  try {
    const store = new FileUserMemoryStore(root);
    const userId = "private-user-identifier";
    const source = userMemoryBackupSource(store, userId);
    assert.equal(source.name.includes(userId), false);
    assert.deepEqual(await source.snapshot(), []);

    await store.save(userId, createUserMemoryEntry("preference", "Prefers concise explanations"));
    await store.save("different-user", createUserMemoryEntry("fact", "Separate user's private note"));

    const bundle = await createBackupBundle([source], createdAt);
    assert.equal(bundle.manifest.entries.length, 1);
    assert.match(bundle.manifest.entries[0]!.path, /^user-memory\/[a-f0-9]{64}\.json$/u);
    assert.equal(verifyBackupBundle(bundle).valid, true);
    const bytes = bundle.files.get(bundle.manifest.entries[0]!.path)!;
    const entries = JSON.parse(Buffer.from(bytes).toString("utf8")) as Array<{ content: string }>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.content, "Prefers concise explanations");
    assert.equal(Buffer.from(bytes).toString("utf8").includes("Separate user's private note"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup coordinator fails closed on duplicate source names and duplicate file paths", async () => {
  const source = { name: "same", async snapshot() { return [{ path: "a.txt", content: Buffer.from("x") }]; } };
  await assert.rejects(createBackupBundle([source, source], createdAt), /Duplicate backup snapshot source/);
  await assert.rejects(createBackupBundle([
    { name: "one", async snapshot() { return [{ path: "same.txt", content: Buffer.from("1") }]; } },
    { name: "two", async snapshot() { return [{ path: "same.txt", content: Buffer.from("2") }]; } },
  ], createdAt), /unique/);
});

test("backup coordinator propagates snapshot failure and does not return a partial bundle", async () => {
  await assert.rejects(createBackupBundle([
    { name: "first", async snapshot() { return [{ path: "a.txt", content: Buffer.from("a") }]; } },
    { name: "broken", async snapshot() { throw new Error("snapshot unavailable"); } },
  ], createdAt), /snapshot unavailable/);
});

test("bundle verification detects tampering, missing files and invalid shapes", async () => {
  const bundle = await createBackupBundle([
    { name: "sessions", async snapshot() { return [{ path: "sessions/a.db", content: Buffer.from("original") }]; } },
  ], createdAt);
  const tampered = { ...bundle, files: new Map([["sessions/a.db", Buffer.from("tampered")]]) };
  assert.equal(verifyBackupBundle(tampered).valid, false);
  assert.equal(verifyBackupBundle({ manifest: bundle.manifest, files: new Map() }).valid, false);
  assert.equal(verifyBackupBundle(null).valid, false);
});

test("backup coordinator bounds the total number of collected entries", async () => {
  const tooMany = Array.from({ length: 10_001 }, (_, index) => ({
    path: `files/${index}.txt`,
    content: Buffer.from("x"),
  }));
  await assert.rejects(createBackupBundle([
    { name: "large", async snapshot() { return tooMany; } },
  ], createdAt), /too many entries/);
});
