import { test } from "node:test";
import assert from "node:assert/strict";
import {
  memoryEntryFromEpisode,
  ProjectEpisodicMemoryStore,
  type ProjectMemoryEntry,
  type ProjectMemoryStore,
} from "../src/brain/project-memory.js";

class MemoryStore implements ProjectMemoryStore {
  entries: ProjectMemoryEntry[] = [];
  async save(entry: ProjectMemoryEntry): Promise<void> {
    const index = this.entries.findIndex((item) => item.id === entry.id);
    if (index >= 0) this.entries[index] = entry;
    else this.entries.push(entry);
  }
  async list(): Promise<ProjectMemoryEntry[]> { return [...this.entries]; }
  async find(query: string): Promise<ProjectMemoryEntry[]> {
    const term = query.toLocaleLowerCase();
    return this.entries.filter((entry) => entry.content.toLocaleLowerCase().includes(term));
  }
}

test("episode entries are deterministic per project and run", () => {
  const event = {
    runId: "run-123",
    outcome: "completed" as const,
    taskSummary: "Add a health endpoint",
    resultSummary: "Implemented and verified the endpoint",
  };
  const first = memoryEntryFromEpisode("sofia", event);
  const second = memoryEntryFromEpisode("sofia", event);
  const otherProject = memoryEntryFromEpisode("other", event);
  assert.equal(first.id, second.id);
  assert.notEqual(first.id, otherProject.id);
  assert.equal(first.kind, "episode");
});

test("episodic store records idempotently and retrieves only the requested project", async () => {
  const backing = new MemoryStore();
  const episodes = new ProjectEpisodicMemoryStore(backing);
  const event = {
    runId: "run-456",
    outcome: "failed" as const,
    taskSummary: "Run the API tests",
    resultSummary: "The database service was unavailable",
    evidenceIds: ["evidence-1"],
    tags: ["tests", "database"],
  };
  await episodes.record("project-a", event);
  await episodes.record("project-a", event);
  await episodes.record("project-b", event);

  const found = await episodes.find("project-a", "database");
  assert.equal(backing.entries.length, 2);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.runId, "run-456");
  assert.equal(found[0]?.outcome, "failed");
  assert.deepEqual(found[0]?.evidenceIds, ["evidence-1"]);
});

test("episode factory bounds fields and rejects empty summaries", () => {
  const entry = memoryEntryFromEpisode("project", {
    runId: "run",
    outcome: "completed",
    taskSummary: "  " + "x".repeat(800),
    resultSummary: "y".repeat(1_500),
  });
  const saved = JSON.parse(entry.content) as { taskSummary: string; resultSummary: string };
  assert.equal(saved.taskSummary.length, 500);
  assert.equal(saved.resultSummary.length, 1_000);
  assert.throws(() => memoryEntryFromEpisode("project", {
    runId: "run",
    outcome: "completed",
    taskSummary: " ",
    resultSummary: "result",
  }));
});
