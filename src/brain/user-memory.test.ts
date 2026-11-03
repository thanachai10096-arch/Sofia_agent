import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUserMemoryEntry, FileUserMemoryStore } from "./user-memory.js";

test("user memory refuses to read through a symlink", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-user-memory-symlink-"));
  const userId = "symlink-user";
  const filename = createHash("sha256").update(userId).digest("hex") + ".json";
  const target = path.join(root, "outside.json");
  const link = path.join(root, filename);
  const original = JSON.stringify([createUserMemoryEntry("preference", "Prefers safe storage")]);
  await writeFile(target, original, "utf8");
  await symlink(target, link);

  const store = new FileUserMemoryStore(root);
  await assert.rejects(store.list(userId), /regular file/);
  await assert.rejects(store.save(userId, createUserMemoryEntry("fact", "Another safe fact")), /regular file/);
  assert.equal(await readFile(target, "utf8"), original);
});
