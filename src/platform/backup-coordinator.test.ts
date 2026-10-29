import test from "node:test";
import assert from "node:assert/strict";
import { createBackupBundle, executeBackupRestoreTransaction, preflightBackupRestore, projectMemoryBackupSource, readBackupBundleDirectory, sqliteSessionBackupSource, stageBackupBundleForRestore, userMemoryBackupSource, verifyBackupBundle, writeBackupBundleDirectory } from "./backup-coordinator.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileProjectMemoryStore, memoryEntryFromConvention } from "../brain/project-memory.js";
import { FileUserMemoryStore, createUserMemoryEntry } from "../brain/user-memory.js";
import { SqliteSessionStore } from "../session/sqlite-store.js";

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

test("SQLite session backup source returns a verified consistent snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-backup-session-source-"));
  const store = await SqliteSessionStore.open(path.join(root, "live.sqlite"));
  try {
    store.save({ id: "backup-session", messages: ["committed before snapshot"], updatedAt: 0 });
    const source = sqliteSessionBackupSource(store);
    const bundle = await createBackupBundle([source], createdAt);
    assert.equal(bundle.manifest.entries.length, 1);
    assert.equal(bundle.manifest.entries[0]!.path, "sessions/sessions.sqlite");
    assert.equal(verifyBackupBundle(bundle).valid, true);
    store.save({ id: "live-after", messages: ["still writable"], updatedAt: 0 });
    assert.deepEqual(store.get("live-after")?.messages, ["still writable"]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite session backup source rejects in-memory stores", async () => {
  const store = await SqliteSessionStore.open(":memory:");
  try {
    await assert.rejects(sqliteSessionBackupSource(store).snapshot(), /in-memory/);
  } finally {
    store.close();
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


test("backup directory export verifies bytes, writes manifest last, and uses private file permissions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-backup-export-"));
  const destination = path.join(root, "export");
  try {
    const bundle = await createBackupBundle([
      { name: "state", async snapshot() {
        return [
          { path: "sessions/session.json", content: Buffer.from('{"ok":true}') },
          { path: "memory/project.json", content: Buffer.from("{}") },
        ];
      } },
    ], createdAt);
    assert.equal(await writeBackupBundleDirectory(bundle, destination), destination);
    const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(destination, "manifest.json"), "utf8")) as { entries: Array<{ path: string; sha256: string }> };
    assert.equal(manifest.entries.length, 2);
    assert.equal(await (await import("node:fs/promises")).readFile(path.join(destination, "sessions/session.json"), "utf8"), '{"ok":true}');
    if (process.platform !== "win32") {
      const stats = await (await import("node:fs/promises")).stat(path.join(destination, "sessions/session.json"));
      assert.equal(stats.mode & 0o777, 0o600);
    }
    await assert.rejects(writeBackupBundleDirectory(bundle, destination), /EEXIST|exist/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup directory export rejects path conflicts and invalid bundles before writing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-backup-export-fail-"));
  try {
    await assert.rejects(createBackupBundle([
      { name: "state", async snapshot() {
        return [
          { path: "a", content: Buffer.from("file") },
          { path: "a/b", content: Buffer.from("conflicting nested file") },
        ];
      } },
    ], createdAt), /conflict as both files and directories/);

    const bundle = await createBackupBundle([
      { name: "state", async snapshot() { return [{ path: "state.json", content: Buffer.from("verified") }]; } },
    ], createdAt);
    const invalid = { ...bundle, files: new Map() };
    const destination = path.join(root, "invalid");
    await assert.rejects(writeBackupBundleDirectory(invalid, destination), /invalid backup bundle/i);
    await assert.rejects((await import("node:fs/promises")).stat(destination), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("restore staging verifies a private copy and cleanup is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-backup-stage-"));
  try {
    const bundle = await createBackupBundle([
      { name: "state", async snapshot() { return [{ path: "state.json", content: Buffer.from("verified") }]; } },
    ], createdAt);
    const staged = await stageBackupBundleForRestore(bundle, root);
    assert.equal(verifyBackupBundle(await readBackupBundleDirectory(staged.directory)).valid, true);
    const stat = await (await import("node:fs/promises")).stat(path.dirname(staged.directory));
    if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o700);
    await staged.cleanup();
    await staged.cleanup();
    await assert.rejects((await import("node:fs/promises")).stat(path.dirname(staged.directory)), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore staging rejects invalid bundles without creating staging output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-backup-stage-invalid-"));
  try {
    const bundle = await createBackupBundle([
      { name: "state", async snapshot() { return [{ path: "state.json", content: Buffer.from("verified") }]; } },
    ], createdAt);
    await assert.rejects(stageBackupBundleForRestore({ ...bundle, files: new Map() }, root), /invalid backup bundle/i);
    assert.deepEqual(await (await import("node:fs/promises")).readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup directory reader round-trips an export and verifies its bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-backup-roundtrip-"));
  const destination = path.join(root, "export");
  try {
    const original = await createBackupBundle([
      { name: "roundtrip", async snapshot() {
        return [
          { path: "sessions/state.json", content: Buffer.from('{"state":"ok"}') },
          { path: "memory/project.json", content: Buffer.from("{}") },
        ];
      } },
    ], createdAt);
    await writeBackupBundleDirectory(original, destination);
    const restored = await readBackupBundleDirectory(destination);
    assert.equal(verifyBackupBundle(restored).valid, true);
    assert.deepEqual(restored.manifest, original.manifest);
    assert.equal(Buffer.from(restored.files.get("sessions/state.json")!).toString("utf8"), '{"state":"ok"}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup directory reader rejects changed bytes and unexpected files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-backup-reader-invalid-"));
  const destination = path.join(root, "export");
  try {
    const bundle = await createBackupBundle([
      { name: "reader", async snapshot() { return [{ path: "state.json", content: Buffer.from("original") }]; } },
    ], createdAt);
    await writeBackupBundleDirectory(bundle, destination);
    const fs = await import("node:fs/promises");
    await fs.writeFile(path.join(destination, "state.json"), "tampered");
    await assert.rejects(readBackupBundleDirectory(destination), /size|verification|checksum/i);

    await fs.writeFile(path.join(destination, "state.json"), "original");
    await fs.writeFile(path.join(destination, "unexpected.txt"), "not in manifest");
    await assert.rejects(readBackupBundleDirectory(destination), /Unexpected backup file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup directory reader rejects unlisted empty directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-backup-reader-extra-dir-"));
  const destination = path.join(root, "export");
  try {
    const bundle = await createBackupBundle([
      { name: "reader", async snapshot() { return [{ path: "state/state.json", content: Buffer.from("{}") }]; } },
    ], createdAt);
    await writeBackupBundleDirectory(bundle, destination);
    await (await import("node:fs/promises")).mkdir(path.join(destination, "unlisted-empty"));
    await assert.rejects(readBackupBundleDirectory(destination), /Unexpected backup directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup directory reader refuses symlink payloads", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-backup-reader-link-"));
  const destination = path.join(root, "export");
  const external = path.join(root, "external.txt");
  try {
    const bundle = await createBackupBundle([
      { name: "reader", async snapshot() { return [{ path: "state.txt", content: Buffer.from("safe") }]; } },
    ], createdAt);
    await writeBackupBundleDirectory(bundle, destination);
    const fs = await import("node:fs/promises");
    await fs.writeFile(external, "outside");
    await fs.unlink(path.join(destination, "state.txt"));
    await fs.symlink(external, path.join(destination, "state.txt"));
    await assert.rejects(readBackupBundleDirectory(destination), /symlink/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("restore preflight creates a deterministic complete plan without mutating the bundle", async () => {
  const bundle = await createBackupBundle([
    { name: "state", async snapshot() {
      return [
        { path: "sessions/state.json", content: Buffer.from("session") },
        { path: "memory/project.json", content: Buffer.from("memory") },
      ];
    } },
  ], createdAt);
  const before = [...bundle.files.entries()].map(([key, value]) => [key, Buffer.from(value).toString("hex")]);
  const plan = preflightBackupRestore(bundle, [
    { name: "memory-store", paths: ["memory/project.json"] },
    { name: "session-store", paths: ["sessions/state.json"] },
  ]);
  assert.deepEqual(plan, {
    format: "sofia-agent-restore-plan",
    version: 1,
    createdAt,
    verifiedFiles: 2,
    verifiedBytes: Buffer.byteLength("session") + Buffer.byteLength("memory"),
    targets: [
      { name: "memory-store", paths: ["memory/project.json"], bytes: Buffer.byteLength("memory") },
      { name: "session-store", paths: ["sessions/state.json"], bytes: Buffer.byteLength("session") },
    ],
  });
  assert.deepEqual([...bundle.files.entries()].map(([key, value]) => [key, Buffer.from(value).toString("hex")]), before);
});

test("restore preflight rejects incomplete, overlapping, unknown, and invalid assignments", async () => {
  const bundle = await createBackupBundle([
    { name: "state", async snapshot() {
      return [
        { path: "a.json", content: Buffer.from("a") },
        { path: "b.json", content: Buffer.from("b") },
      ];
    } },
  ], createdAt);
  assert.throws(() => preflightBackupRestore(bundle, [{ name: "only", paths: ["a.json"] }]), /unassigned/i);
  assert.throws(() => preflightBackupRestore(bundle, [
    { name: "one", paths: ["a.json"] },
    { name: "two", paths: ["a.json", "b.json"] },
  ]), /assigned more than once/i);
  assert.throws(() => preflightBackupRestore(bundle, [
    { name: "one", paths: ["a.json", "b.json", "not-in-bundle.json"] },
  ]), /not in the verified bundle/i);
  assert.throws(() => preflightBackupRestore(bundle, [
    { name: "same", paths: ["a.json"] },
    { name: "same", paths: ["b.json"] },
  ]), /Duplicate restore target name/i);
  assert.throws(() => preflightBackupRestore({ ...bundle, files: new Map() }, [
    { name: "one", paths: ["a.json", "b.json"] },
  ]), /invalid bundle/i);
});


test("restore transaction preflights and captures every rollback snapshot before applying", async () => {
  const bundle = await createBackupBundle([
    { name: "state", async snapshot() {
      return [
        { path: "a.json", content: Buffer.from("A") },
        { path: "b.json", content: Buffer.from("B") },
      ];
    } },
  ], createdAt);
  const events: string[] = [];
  const makeAdapter = (name: string, targetPath: string) => ({
    name,
    paths: [targetPath],
    async preflight() { events.push(`preflight:${name}`); },
    async captureRollback() { events.push(`snapshot:${name}`); return `old-${name}`; },
    async apply() { events.push(`apply:${name}`); },
    async rollback(snapshot: unknown) { events.push(`rollback:${name}:${String(snapshot)}`); },
  });
  const result = await executeBackupRestoreTransaction(bundle, [
    makeAdapter("a-target", "a.json"),
    makeAdapter("b-target", "b.json"),
  ]);
  assert.deepEqual(events, [
    "preflight:a-target", "preflight:b-target",
    "snapshot:a-target", "snapshot:b-target",
    "apply:a-target", "apply:b-target",
  ]);
  assert.deepEqual(result.appliedTargets, ["a-target", "b-target"]);
});

test("restore transaction rolls back in reverse order when an apply partially fails", async () => {
  const bundle = await createBackupBundle([
    { name: "state", async snapshot() {
      return [
        { path: "a.json", content: Buffer.from("A") },
        { path: "b.json", content: Buffer.from("B") },
      ];
    } },
  ], createdAt);
  const events: string[] = [];
  const adapter = (name: string, targetPath: string, fail = false) => ({
    name,
    paths: [targetPath],
    async preflight() { events.push(`preflight:${name}`); },
    async captureRollback() { events.push(`snapshot:${name}`); return `old-${name}`; },
    async apply() {
      events.push(`apply:${name}`);
      if (fail) throw new Error("simulated partial write");
    },
    async rollback(snapshot: unknown) { events.push(`rollback:${name}:${String(snapshot)}`); },
  });
  await assert.rejects(executeBackupRestoreTransaction(bundle, [
    adapter("a-target", "a.json"),
    adapter("b-target", "b.json", true),
  ]), /rollback was attempted/i);
  assert.deepEqual(events, [
    "preflight:a-target", "preflight:b-target",
    "snapshot:a-target", "snapshot:b-target",
    "apply:a-target", "apply:b-target",
    "rollback:b-target:old-b-target", "rollback:a-target:old-a-target",
  ]);
});

test("restore transaction refuses preflight failures before snapshots or writes", async () => {
  const bundle = await createBackupBundle([
    { name: "state", async snapshot() { return [{ path: "a.json", content: Buffer.from("A") }]; } },
  ], createdAt);
  const events: string[] = [];
  await assert.rejects(executeBackupRestoreTransaction(bundle, [{
    name: "target",
    paths: ["a.json"],
    async preflight() { events.push("preflight"); throw new Error("unsafe destination"); },
    async captureRollback() { events.push("snapshot"); return "old"; },
    async apply() { events.push("apply"); },
    async rollback() { events.push("rollback"); },
  }]), /unsafe destination/);
  assert.deepEqual(events, ["preflight"]);
});

test("restore transaction reports rollback failures without hiding the apply failure", async () => {
  const bundle = await createBackupBundle([
    { name: "state", async snapshot() { return [{ path: "a.json", content: Buffer.from("A") }]; } },
  ], createdAt);
  await assert.rejects(executeBackupRestoreTransaction(bundle, [{
    name: "target",
    paths: ["a.json"],
    async preflight() {},
    async captureRollback() { return "old"; },
    async apply() { throw new Error("apply broke"); },
    async rollback() { throw new Error("rollback broke"); },
  }]), /rollback was incomplete.*apply broke.*rollback broke/i);
});


test("restore transaction continues reverse rollback after one rollback adapter fails", async () => {
  const bundle = await createBackupBundle([
    { name: "state", async snapshot() {
      return [
        { path: "a.json", content: Buffer.from("A") },
        { path: "b.json", content: Buffer.from("B") },
        { path: "c.json", content: Buffer.from("C") },
      ];
    } },
  ], createdAt);
  const events: string[] = [];
  const makeAdapter = (name: string, targetPath: string, failApply = false, failRollback = false) => ({
    name,
    paths: [targetPath],
    async preflight() {},
    async captureRollback() { return `old-${name}`; },
    async apply() {
      events.push(`apply:${name}`);
      if (failApply) throw new Error("apply failed");
    },
    async rollback(snapshot: unknown) {
      events.push(`rollback:${name}:${String(snapshot)}`);
      if (failRollback) throw new Error(`rollback failed for ${name}`);
    },
  });
  await assert.rejects(executeBackupRestoreTransaction(bundle, [
    makeAdapter("a", "a.json"),
    makeAdapter("b", "b.json", false, true),
    makeAdapter("c", "c.json", true),
  ]), /rollback was incomplete.*apply failed.*rollback failed for b/i);
  assert.deepEqual(events, [
    "apply:a", "apply:b", "apply:c",
    "rollback:c:old-c", "rollback:b:old-b", "rollback:a:old-a",
  ]);
});

test("restore transaction does not apply any target when rollback snapshot capture fails", async () => {
  const bundle = await createBackupBundle([
    { name: "state", async snapshot() {
      return [
        { path: "a.json", content: Buffer.from("A") },
        { path: "b.json", content: Buffer.from("B") },
      ];
    } },
  ], createdAt);
  const events: string[] = [];
  await assert.rejects(executeBackupRestoreTransaction(bundle, [
    {
      name: "a",
      paths: ["a.json"],
      async preflight() { events.push("preflight:a"); },
      async captureRollback() { events.push("snapshot:a"); return "old-a"; },
      async apply() { events.push("apply:a"); },
      async rollback() { events.push("rollback:a"); },
    },
    {
      name: "b",
      paths: ["b.json"],
      async preflight() { events.push("preflight:b"); },
      async captureRollback() { events.push("snapshot:b"); throw new Error("snapshot unavailable"); },
      async apply() { events.push("apply:b"); },
      async rollback() { events.push("rollback:b"); },
    },
  ]), /snapshot unavailable/);
  assert.deepEqual(events, [
    "preflight:a", "preflight:b",
    "snapshot:a", "snapshot:b",
  ]);
});


test("restore staging removes its private temporary root when export fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-backup-stage-failure-"));
  try {
    const bundle = await createBackupBundle([
      { name: "reserved-path", async snapshot() {
        return [{ path: "manifest.json", content: Buffer.from("payload must not shadow manifest") }];
      } },
    ], createdAt);
    await assert.rejects(stageBackupBundleForRestore(bundle, root), /reserved for the manifest/i);
    const remaining = await (await import("node:fs/promises")).readdir(root);
    assert.deepEqual(remaining, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("restore plan target ordering is independent of host locale", async () => {
  const bundle = await createBackupBundle([
    { name: "state", async snapshot() {
      return [
        { path: "a.json", content: Buffer.from("A") },
        { path: "b.json", content: Buffer.from("B") },
        { path: "c.json", content: Buffer.from("C") },
      ];
    } },
  ], createdAt);
  const plan = preflightBackupRestore(bundle, [
    { name: "z-target", paths: ["a.json"] },
    { name: "ä-target", paths: ["b.json"] },
    { name: "A-target", paths: ["c.json"] },
  ]);
  assert.deepEqual(plan.targets.map((target) => target.name), ["A-target", "z-target", "ä-target"]);
});


test("restore transaction rejects malformed adapters before invoking any adapter", async () => {
  const bundle = await createBackupBundle([
    { name: "state", async snapshot() { return [{ path: "a.json", content: Buffer.from("A") }]; } },
  ], createdAt);
  const events: string[] = [];
  const valid = {
    name: "target",
    paths: ["a.json"],
    async preflight() { events.push("preflight"); },
    async captureRollback() { events.push("snapshot"); return "old"; },
    async apply() { events.push("apply"); },
    async rollback() { events.push("rollback"); },
  };

  await assert.rejects(
    executeBackupRestoreTransaction(bundle, null as never),
    /adapters must be an array/i,
  );
  await assert.rejects(
    executeBackupRestoreTransaction(bundle, [null] as never),
    /adapter must be an object/i,
  );
  await assert.rejects(
    executeBackupRestoreTransaction(bundle, [{ ...valid, apply: undefined }] as never),
    /missing required method: apply/i,
  );
  await assert.rejects(
    executeBackupRestoreTransaction(bundle, [{ ...valid, paths: "a.json" }] as never),
    /array of paths/i,
  );
  assert.deepEqual(events, []);
});


test("backup bundle owns snapshot bytes so later source mutation cannot invalidate it", async () => {
  const sourceBytes = Buffer.from("original snapshot");
  const bundle = await createBackupBundle([
    { name: "mutable-source", async snapshot() {
      return [{ path: "state.txt", content: sourceBytes }];
    } },
  ], createdAt);
  sourceBytes.fill(0x78);
  assert.equal(verifyBackupBundle(bundle).valid, true);
  assert.equal(Buffer.from(bundle.files.get("state.txt")!).toString("utf8"), "original snapshot");
});
