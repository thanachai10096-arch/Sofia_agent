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

test("concurrent project projection syncs cannot leave an older snapshot on disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "sofia-markdown-project-race-"));
  try {
    const entries: ProjectMemoryEntry[] = [];
    let firstList = true;
    const base: ProjectMemoryStore = {
      async save(entry) {
        const index = entries.findIndex((item) => item.id === entry.id);
        if (index < 0) entries.push(entry);
        else entries[index] = entry;
      },
      async list() {
        const snapshot = [...entries];
        if (firstList) {
          firstList = false;
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        return snapshot;
      },
      async find() { return []; },
    };
    const store = new MarkdownProjectMemoryStore(base, { root });
    const now = new Date().toISOString();
    const makeEntry = (id: string, content: string): ProjectMemoryEntry => ({
      id, project: "/workspace/race", kind: "decision", content,
      confidence: 1, createdAt: now, updatedAt: now, uses: 0,
    });

    await Promise.all([
      store.save(makeEntry("decision-a", "First concurrent decision")),
      store.save(makeEntry("decision-b", "Second concurrent decision")),
    ]);

    const key = createHash("sha256").update("/workspace/race").digest("hex");
    const projection = await readFile(join(root, "projects", key, "MEMORY.md"), "utf8");
    assert.match(projection, /First concurrent decision/);
    assert.match(projection, /Second concurrent decision/);
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


test("concurrent user clear and save leave the canonical memory and Markdown projection consistent", async () => {
  const root = await mkdtemp(join(tmpdir(), "sofia-markdown-user-race-"));
  try {
    const entries: ReturnType<typeof createUserMemoryEntry>[] = [];
    let signalClearStarted!: () => void;
    const clearStarted = new Promise<void>((resolve) => { signalClearStarted = resolve; });
    let finishClear!: () => void;
    const clearGate = new Promise<void>((resolve) => { finishClear = resolve; });
    const base: UserMemoryStore = {
      async save(_userId, entry) {
        const index = entries.findIndex((item) => item.id === entry.id);
        if (index < 0) entries.push(entry);
        else entries[index] = entry;
      },
      async list() { return [...entries]; },
      async find() { return [...entries]; },
      async delete(_userId, id) {
        const next = entries.filter((entry) => entry.id !== id);
        const deleted = next.length !== entries.length;
        entries.splice(0, entries.length, ...next);
        return deleted;
      },
      async clear() {
        entries.splice(0, entries.length);
        signalClearStarted();
        await clearGate;
      },
    };
    const store = new MarkdownUserMemoryStore(base, { root });
    const clearing = store.clear("principal-race");
    await clearStarted;
    const saving = store.save("principal-race", createUserMemoryEntry("fact", "Saved after clear"));
    finishClear();
    await Promise.all([clearing, saving]);

    assert.equal(entries.length, 1);
    assert.match(
      await readFile(join(root, "users", createHash("sha256").update("principal-race").digest("hex"), "USER.md"), "utf8"),
      /Saved after clear/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
