import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
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
