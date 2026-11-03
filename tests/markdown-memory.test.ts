import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserMemoryEntry, FileUserMemoryStore } from "../src/brain/user-memory.js";
import type { UserMemoryStore } from "../src/brain/user-memory.js";
import { MarkdownProjectMemoryStore, MarkdownUserMemoryStore } from "../src/brain/markdown-memory.js";
import { FileProjectMemoryStore } from "../src/brain/project-memory.js";
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


test("canonical memory mutations succeed and report when Markdown projections fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "sofia-markdown-projection-failure-"));
  try {
    const blockedRoot = join(root, "not-a-directory");
    await writeFile(blockedRoot, "intentionally blocks projection directory creation");
    const userDiagnostics: string[] = [];
    const canonicalUserStore = new FileUserMemoryStore(join(root, "canonical-user"));
    const userStore = new MarkdownUserMemoryStore(canonicalUserStore, {
      root: blockedRoot,
      onProjectionError: (scope) => userDiagnostics.push(scope),
    });
    const entry = createUserMemoryEntry("preference", "Canonical write must survive projection failure");

    await assert.doesNotReject(userStore.save("principal-projection-failure", entry));
    assert.equal((await canonicalUserStore.list("principal-projection-failure")).some((item) => item.id === entry.id), true);
    assert.deepEqual(userDiagnostics, ["user"]);

    assert.equal(await userStore.delete("principal-projection-failure", entry.id), true);
    assert.equal((await canonicalUserStore.list("principal-projection-failure")).some((item) => item.id === entry.id), false);
    assert.deepEqual(userDiagnostics, ["user", "user"]);

    const projectEntries: ProjectMemoryEntry[] = [];
    const projectDiagnostics: string[] = [];
    const canonicalProjectStore: ProjectMemoryStore = {
      async save(projectEntry) {
        const index = projectEntries.findIndex((item) => item.id === projectEntry.id);
        if (index < 0) projectEntries.push(projectEntry);
        else projectEntries[index] = projectEntry;
      },
      async list() { return [...projectEntries]; },
      async find() { return []; },
    };
    const projectStore = new MarkdownProjectMemoryStore(canonicalProjectStore, {
      root: blockedRoot,
      onProjectionError: (scope) => projectDiagnostics.push(scope),
    });
    const now = new Date().toISOString();
    const projectEntry: ProjectMemoryEntry = {
      id: "projection-failure-project",
      project: "/workspace/projection-failure",
      kind: "decision",
      content: "Canonical project memory survives a failed snapshot",
      confidence: 1,
      createdAt: now,
      updatedAt: now,
      uses: 0,
    };

    await assert.doesNotReject(projectStore.save(projectEntry));
    assert.equal(projectEntries.some((item) => item.id === projectEntry.id), true);
    assert.deepEqual(projectDiagnostics, ["project"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("projection diagnostics cannot make a committed canonical mutation fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "sofia-markdown-projection-diagnostic-"));
  try {
    const blockedRoot = join(root, "not-a-directory");
    await writeFile(blockedRoot, "block");
    const canonical = new FileUserMemoryStore(join(root, "canonical"));
    const store = new MarkdownUserMemoryStore(canonical, {
      root: blockedRoot,
      onProjectionError() { throw new Error("diagnostic sink unavailable"); },
    });
    const entry = createUserMemoryEntry("fact", "Preserve canonical write");
    await assert.doesNotReject(store.save("principal-diagnostic", entry));
    assert.equal((await canonical.list("principal-diagnostic")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("canonical user and project memories survive store reconstruction after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "sofia-memory-restart-"));
  try {
    const canonicalRoot = join(root, "canonical");
    const projectionRoot = join(root, "projections");
    const userId = "restart-principal";
    const userEntry = createUserMemoryEntry("preference", "Prefers restart-safe memory");
    const projectEntry: ProjectMemoryEntry = {
      id: "restart-project-decision",
      project: "/workspace/restart",
      kind: "decision",
      content: "Keep canonical project memory durable",
      confidence: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      uses: 0,
    };

    const firstUserStore = new MarkdownUserMemoryStore(
      new FileUserMemoryStore(join(canonicalRoot, "users")),
      { root: projectionRoot },
    );
    const firstProjectStore = new MarkdownProjectMemoryStore(
      new FileProjectMemoryStore(projectEntry.project, join(canonicalRoot, "projects")),
      { root: projectionRoot },
    );
    await firstUserStore.save(userId, userEntry);
    await firstProjectStore.save(projectEntry);

    // Recreate every store/decorator as a new process would after restart.
    const restartedUserStore = new MarkdownUserMemoryStore(
      new FileUserMemoryStore(join(canonicalRoot, "users")),
      { root: projectionRoot },
    );
    const restartedProjectStore = new MarkdownProjectMemoryStore(
      new FileProjectMemoryStore(projectEntry.project, join(canonicalRoot, "projects")),
      { root: projectionRoot },
    );

    assert.equal((await restartedUserStore.list(userId)).some((entry) => entry.id === userEntry.id), true);
    assert.equal((await restartedUserStore.find(userId, "restart-safe memory")).some((entry) => entry.id === userEntry.id), true);
    assert.equal((await restartedProjectStore.list()).some((entry) => entry.id === projectEntry.id), true);
    assert.equal((await restartedProjectStore.find("canonical project memory")).some((entry) => entry.id === projectEntry.id), true);
    assert.match(
      await readFile(join(projectionRoot, "users", createHash("sha256").update(userId).digest("hex"), "USER.md"), "utf8"),
      /Prefers restart-safe memory/,
    );
    assert.match(
      await readFile(join(projectionRoot, "projects", createHash("sha256").update(projectEntry.project).digest("hex"), "MEMORY.md"), "utf8"),
      /Keep canonical project memory durable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
