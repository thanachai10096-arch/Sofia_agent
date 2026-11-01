import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProjectMemoryFeedbackStore,
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
  async find(): Promise<ProjectMemoryEntry[]> { return [...this.entries]; }
}

test("memory feedback is idempotent per project, memory, and source run", async () => {
  const backing = new MemoryStore();
  const feedback = new ProjectMemoryFeedbackStore(backing);
  const event = {
    memoryId: "memory-1",
    sourceRunId: "run-1",
    signal: "helpful" as const,
    note: "The previous fix worked",
  };
  await feedback.record("project-a", event);
  await feedback.record("project-a", event);
  await feedback.record("project-b", event);

  assert.equal(backing.entries.length, 2);
  const summary = await feedback.summarize("project-a", "memory-1");
  assert.equal(summary.total, 1);
  assert.equal(summary.helpful, 1);
  assert.equal(summary.utilityScore, 1);
});

test("feedback summary weights incorrect reports and stays within bounds", async () => {
  const backing = new MemoryStore();
  const feedback = new ProjectMemoryFeedbackStore(backing);
  const signals = ["helpful", "not_helpful", "incorrect", "outdated"] as const;
  for (let index = 0; index < signals.length; index += 1) {
    await feedback.record("project", {
      memoryId: "memory",
      sourceRunId: "run-" + index,
      signal: signals[index]!,
    });
  }
  const summary = await feedback.summarize("project", "memory");
  assert.equal(summary.total, 4);
  assert.equal(summary.helpful, 1);
  assert.equal(summary.notHelpful, 1);
  assert.equal(summary.incorrect, 1);
  assert.equal(summary.outdated, 1);
  assert.equal(summary.utilityScore, -0.75);
});

test("feedback is scoped to its project and memory and rejects incomplete identity", async () => {
  const backing = new MemoryStore();
  const feedback = new ProjectMemoryFeedbackStore(backing);
  await feedback.record("project-a", {
    memoryId: "memory-a",
    sourceRunId: "run-a",
    signal: "incorrect",
  });
  assert.equal((await feedback.summarize("project-b", "memory-a")).total, 0);
  assert.equal((await feedback.summarize("project-a", "memory-b")).total, 0);
  await assert.rejects(() => feedback.record(" ", {
    memoryId: "memory-a",
    sourceRunId: "run-b",
    signal: "helpful",
  }));
});
