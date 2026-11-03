import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { FileProjectMemoryStore, memoryEntryFromConvention, memoryEntryFromRepair } from "./project-memory.js";

test("project memory survives a new store instance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-memory-test-"));
  const first = new FileProjectMemoryStore("project-a", root);
  await first.save(memoryEntryFromConvention("project-a", "Use strict TypeScript"));
  await first.save(memoryEntryFromRepair("project-a", "type_error", "fix-implementation", "Fixed the failing type"));
  const second = new FileProjectMemoryStore("project-a", root);
  const entries = await second.list();
  assert.equal(entries.length, 2);
  assert.ok((await second.find("TypeScript")).length > 0);
  assert.ok((await second.find("type_error")).length > 0);
});

test("project memory writes valid JSON", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-memory-json-"));
  const store = new FileProjectMemoryStore("project-b", root);
  await store.save(memoryEntryFromConvention("project-b", "Run tests before build"));
  const files = await import("node:fs/promises");
  const names = await files.readdir(root);
  const raw = await readFile(path.join(root, names[0]!), "utf8");
  assert.doesNotThrow(() => JSON.parse(raw));
});


test("project memory files use private permissions on POSIX", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-memory-permissions-"));
  const store = new FileProjectMemoryStore("private-project", root);
  await store.save(memoryEntryFromConvention("private-project", "Do not expose private project context"));
  if (process.platform !== "win32") {
    const names = await readdir(root);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(root, names[0]!))).mode & 0o777, 0o600);
  }
});


test("project memory ranks exact token and phrase matches above substring false positives", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-memory-ranking-"));
  const store = new FileProjectMemoryStore("ranking-project", root);
  const now = new Date().toISOString();
  await store.save({
    id: "substring", project: "ranking-project", kind: "decision",
    content: "The latest delivery contains no testing guidance.",
    confidence: 1, createdAt: now, updatedAt: now, uses: 0,
  });
  await store.save({
    id: "exact", project: "ranking-project", kind: "convention",
    content: "Run tests before every build; TypeScript strict mode is required.",
    confidence: 0.9, createdAt: now, updatedAt: now, uses: 0,
  });

  const results = await store.find("tests before every build");
  assert.equal(results[0]?.id, "exact");
  assert.equal(results.some((entry) => entry.id === "substring"), false);
});

test("project memory returns no results for empty or punctuation-only queries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-memory-empty-query-"));
  const store = new FileProjectMemoryStore("empty-query-project", root);
  await store.save(memoryEntryFromConvention("empty-query-project", "Run tests before build"));
  assert.deepEqual(await store.find("   "), []);
  assert.deepEqual(await store.find("!?..."), []);
});

test("project memory ranks entries matching more query terms ahead of weaker matches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-memory-multi-term-"));
  const store = new FileProjectMemoryStore("multi-term-project", root);
  const now = new Date().toISOString();
  await store.save({
    id: "weak", project: "multi-term-project", kind: "decision",
    content: "Build pipeline notes", confidence: 1,
    createdAt: now, updatedAt: now, uses: 0,
  });
  await store.save({
    id: "strong", project: "multi-term-project", kind: "convention",
    content: "Build test typecheck before release", confidence: 0.5,
    createdAt: now, updatedAt: now, uses: 0,
  });

  const results = await store.find("build test typecheck");
  assert.equal(results[0]?.id, "strong");
  assert.equal(results.some((entry) => entry.id === "weak"), true);
});
test("project memory identity includes project so equal IDs cannot overwrite another project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-memory-project-identity-"));
  const store = new FileProjectMemoryStore("shared-workspace", root);
  const now = new Date().toISOString();
  await store.save({ id: "same-id", project: "project-a", kind: "decision", content: "Project A private decision", confidence: 0.9, createdAt: now, updatedAt: now, uses: 0 });
  await store.save({ id: "same-id", project: "project-b", kind: "decision", content: "Project B separate decision", confidence: 0.9, createdAt: now, updatedAt: now, uses: 0 });
  await store.save({ id: "same-id", project: "project-a", kind: "decision", content: "Project A updated decision", confidence: 0.9, createdAt: now, updatedAt: now, uses: 1 });
  const entries = await store.list();
  assert.equal(entries.length, 2);
  assert.equal(entries.find((entry) => entry.project === "project-a")?.content, "Project A updated decision");
  assert.equal(entries.find((entry) => entry.project === "project-b")?.content, "Project B separate decision");
});


test("concurrent project memory writes from separate store instances do not lose records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-memory-concurrent-"));
  const first = new FileProjectMemoryStore("concurrent-project", root);
  const second = new FileProjectMemoryStore("concurrent-project", root);
  const now = new Date().toISOString();
  const writes = Array.from({ length: 32 }, (_, index) => {
    const store = index % 2 === 0 ? first : second;
    return store.save({
      id: `concurrent-${index}`,
      project: "concurrent-project",
      kind: "decision",
      content: `Concurrent memory record ${index}`,
      confidence: 0.9,
      createdAt: now,
      updatedAt: now,
      uses: 0,
    });
  });

  await Promise.all(writes);
  const entries = await first.list();
  assert.equal(entries.length, 32);
  assert.deepEqual(
    entries.map((entry) => entry.id).sort(),
    Array.from({ length: 32 }, (_, index) => `concurrent-${index}`).sort(),
  );
});

test("project memory refuses to read through a symlink", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-memory-symlink-"));
  const project = "symlink-project";
  const filename = createHash("sha256").update(project).digest("hex") + ".json";
  const target = path.join(root, "outside.json");
  const link = path.join(root, filename);
  const original = JSON.stringify([memoryEntryFromConvention(project, "Do not follow this link")]);
  await writeFile(target, original, "utf8");
  await symlink(target, link);

  const store = new FileProjectMemoryStore(project, root);
  await assert.rejects(store.list(), /regular file/);
  assert.deepEqual(store.readSync(), []);
  assert.equal(await readFile(target, "utf8"), original);
});
