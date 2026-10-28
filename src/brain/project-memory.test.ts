import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileProjectMemoryStore, PersistentSkillLedger, memoryEntryFromConvention, memoryEntryFromRepair } from "./project-memory.js";
import type { LearnedSkillCandidate } from "./learning.js";

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


test("persistent skill ledger merges repeated verified workflows and restores trigger variants", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-skill-ledger-"));
  const firstStore = new FileProjectMemoryStore("skill-ledger-owner-a", root);
  const ledger = new PersistentSkillLedger(firstStore);
  const first: LearnedSkillCandidate = {
    name: "workflow-code-review-a1b2",
    trigger: "Review this TypeScript pull request",
    category: "unknown",
    strategy: "initial",
    procedure: ["inspect changed files", "check tests and security", "summarize verified findings"],
    verification: ["test", "build"],
    evidenceIds: ["run-1"],
  };
  const repeat: LearnedSkillCandidate = {
    ...first,
    trigger: "Review a TypeScript PR for regressions",
    procedure: ["inspect changed files", "check CI evidence", "summarize verified findings"],
    evidenceIds: ["run-2"],
  };
  ledger.record(first);
  ledger.record(repeat);
  await ledger.flush();

  assert.equal(ledger.list().length, 1);
  const merged = ledger.list()[0]!;
  assert.ok(merged.triggers?.includes(first.trigger));
  assert.ok(merged.triggers?.includes(repeat.trigger));
  assert.ok(merged.procedure.includes("check CI evidence"));
  assert.deepEqual(new Set(merged.evidenceIds), new Set(["run-1", "run-2"]));

  const restored = new PersistentSkillLedger(new FileProjectMemoryStore("skill-ledger-owner-a", root));
  assert.equal(restored.list().length, 1);
  assert.ok(restored.list()[0]?.triggers?.includes(repeat.trigger));
});


test("persistent skill ledger reports durable storage failures when flushed", async () => {
  const brokenStore = {
    async save() { throw new Error("simulated disk failure"); },
    async list() { return []; },
    async find() { return []; },
  };
  const ledger = new PersistentSkillLedger(brokenStore);
  ledger.record({
    name: "workflow-persistence-test",
    trigger: "Run a verified persistence check",
    category: "unknown",
    strategy: "initial",
    procedure: ["inspect the target", "perform the check", "verify the result"],
    verification: ["test"],
    evidenceIds: ["trusted-check-1"],
  });
  await assert.rejects(ledger.flush(), /Failed to persist learned skill/);
});
