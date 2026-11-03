import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProjectMemoryEntry, ProjectMemoryStore } from "../src/brain/project-memory.js";
import { ScopedProjectMemoryStore } from "../src/brain/scoped-project-memory.js";
import { listProjectMemoryVersions, rollbackProjectMemory, saveVersionedProjectMemory } from "../src/brain/memory-versioning.js";
import { MemorySecurityAudit } from "../src/security/audit.js";

class Store implements ProjectMemoryStore {
  entries: ProjectMemoryEntry[] = [];
  async save(entry: ProjectMemoryEntry): Promise<void> {
    const index = this.entries.findIndex((item) => item.id === entry.id && item.project === entry.project);
    if (index >= 0) this.entries[index] = entry;
    else this.entries.push(entry);
  }
  async list(): Promise<ProjectMemoryEntry[]> { return [...this.entries]; }
  async find(query: string): Promise<ProjectMemoryEntry[]> {
    return this.entries.filter((entry) => entry.content.includes(query));
  }
}
const entry = (project: string, id: string, content: string): ProjectMemoryEntry => ({
  id, project, kind: "decision", content, confidence: 0.9,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", uses: 0,
});

test("scoped project memory filters list and retrieval before returning data", async () => {
  const backing = new Store();
  await backing.save(entry("project-a", "a", "private alpha architecture"));
  await backing.save(entry("project-b", "b", "private alpha credentials"));
  const scoped = new ScopedProjectMemoryStore(backing, { principalId: "user-a", projects: ["project-a"] });
  assert.deepEqual((await scoped.list()).map((item) => item.id), ["a"]);
  assert.deepEqual((await scoped.find("private alpha")).map((item) => item.id), ["a"]);
});

test("scoped project memory rejects writes outside the capability without mutation", async () => {
  const backing = new Store();
  const scoped = new ScopedProjectMemoryStore(backing, { principalId: "user-a", projects: ["project-a"] });
  await assert.rejects(scoped.save(entry("project-b", "b", "must not persist")), /outside the authorized scope/);
  assert.equal(backing.entries.length, 0);
});

test("read-only scopes deny writes and no-read scopes deny list/find", async () => {
  const backing = new Store();
  const readOnly = new ScopedProjectMemoryStore(backing, { principalId: "user-a", projects: ["project-a"], canWrite: false });
  await assert.rejects(readOnly.save(entry("project-a", "a", "no write")), /outside the authorized scope/);
  const noRead = new ScopedProjectMemoryStore(backing, { principalId: "user-a", projects: ["project-a"], canRead: false });
  await assert.rejects(noRead.list(), /not authorized/);
  await assert.rejects(noRead.find("anything"), /not authorized/);
});

test("scope decisions are written to the existing security audit sink", async () => {
  const backing = new Store();
  const audit = new MemorySecurityAudit();
  const scoped = new ScopedProjectMemoryStore(backing, { principalId: "user-a", projects: ["project-a"] }, { audit });
  await scoped.save(entry("project-a", "a", "allowed"));
  await assert.rejects(scoped.save(entry("project-b", "b", "denied")));
  const events = audit.list();
  assert.equal(events.length, 2);
  assert.equal(events[0]?.decision, "allow");
  assert.equal(events[1]?.decision, "deny");
  assert.equal(events[1]?.principalId, "user-a");
});
test("version history and rollback remain inside the scoped project capability", async () => {
  const backing = new Store();
  const initial = entry("project-a", "memory-a", "initial project decision");
  await backing.save(initial);
  const scoped = new ScopedProjectMemoryStore(backing, { principalId: "user-a", projects: ["project-a"] });
  const saved = await saveVersionedProjectMemory(scoped, { ...initial, content: "updated project decision", updatedAt: "2026-02-01T00:00:00.000Z" }, {
    actor: "user-a", reason: "approved update", occurredAt: "2026-02-01T00:00:00.000Z",
  });
  assert.equal(saved.saved, true);
  const history = await listProjectMemoryVersions(scoped, "project-a", "memory-a");
  assert.equal(history.length, 1);
  const denied = await rollbackProjectMemory(scoped, "project-b", history[0]!.versionId, {
    actor: "user-a", reason: "cross-scope attempt", occurredAt: "2026-03-01T00:00:00.000Z",
  });
  assert.equal(denied.reason, "not-found");
  const restored = await rollbackProjectMemory(scoped, "project-a", history[0]!.versionId, {
    actor: "user-a", reason: "restore", occurredAt: "2026-03-01T00:00:00.000Z",
  });
  assert.equal(restored.saved, true);
  assert.equal(restored.entry?.content, "initial project decision");
});
