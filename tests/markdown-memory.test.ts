import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserMemoryEntry, FileUserMemoryStore } from "../src/brain/user-memory.js";
import { MarkdownProjectMemoryStore, MarkdownUserMemoryStore } from "../src/brain/markdown-memory.js";
import type { ProjectMemoryEntry, ProjectMemoryStore } from "../src/brain/project-memory.js";

test("Markdown user memory mirrors explicit entries into private per-user files", async () => {
  const root = await mkdtemp(join(tmpdir(), "sofia-markdown-user-"));
  try {
    const store = new MarkdownUserMemoryStore(new FileUserMemoryStore(join(root, "canonical")), { root: join(root, "markdown") });
    const entry = createUserMemoryEntry("preference", "Prefers concise answers");
    await store.save("principal-a", entry);
    const a = await readFile(join(root, "markdown", "users", createHash("sha256").update("principal-a").digest("hex"), "USER.md"), "utf8");
    assert.match(a, /USER\.md/);
    assert.match(a, /Prefers concise answers/);
    await store.save("principal-b", createUserMemoryEntry("fact", "Uses TypeScript"));
    assert.doesNotMatch(a, /Uses TypeScript/);
    assert.equal(await store.delete("principal-a", entry.id), true);
    assert.match(await readFile(join(root, "markdown", "users", createHash("sha256").update("principal-a").digest("hex"), "USER.md"), "utf8"), /No saved memories/);
    const bFile = join(root, "markdown", "users", createHash("sha256").update("principal-b").digest("hex"), "USER.md");
    await store.clear("principal-b");
    await assert.rejects(readFile(bFile, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Markdown project memory writes project-scoped MEMORY.md snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "sofia-markdown-project-"));
  try {
    const entries: ProjectMemoryEntry[] = [];
    const base: ProjectMemoryStore = {
      async save(entry) { const index = entries.findIndex((item) => item.id === entry.id); if (index < 0) entries.push(entry); else entries[index] = entry; },
      async list() { return [...entries]; },
      async find() { return []; },
    };
    const store = new MarkdownProjectMemoryStore(base, { root });
    const now = new Date().toISOString();
    await store.save({ id: "decision-1", project: "/workspace/a", kind: "decision", content: "Use a stable adapter", confidence: 1, createdAt: now, updatedAt: now, uses: 0 });
    await store.save({ id: "decision-2", project: "/workspace/b", kind: "decision", content: "Keep tenant data separate", confidence: 1, createdAt: now, updatedAt: now, uses: 0 });
    const aKey = createHash("sha256").update("/workspace/a").digest("hex");
    const bKey = createHash("sha256").update("/workspace/b").digest("hex");
    const a = await readFile(join(root, "projects", aKey, "MEMORY.md"), "utf8");
    const b = await readFile(join(root, "projects", bKey, "MEMORY.md"), "utf8");
    assert.match(a, /Use a stable adapter/);
    assert.doesNotMatch(a, /Keep tenant data separate/);
    assert.match(b, /Keep tenant data separate/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
