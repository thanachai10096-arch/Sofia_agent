import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectMemoryEntry, ProjectMemoryStore } from "../brain/project-memory.js";
import { createProjectMemoryLearningRecorder } from "./project-memory-adapter.js";

test("project memory recorder uses stable job-cycle IDs for replay-safe upserts", async () => {
  const entries = new Map<string, ProjectMemoryEntry>();
  const store: ProjectMemoryStore = {
    save: async (entry) => { entries.set(entry.id, entry); },
    list: async () => [...entries.values()],
    find: async () => [],
  };
  const recordLearning = createProjectMemoryLearningRecorder(store, (principalId) => `project-${principalId}`);
  const input = {
    principalId: "tenant-7",
    idempotencyKey: "autonomy-job:job-abc:1",
    question: "Why did the build fail?",
    finding: { summary: "A missing generated file caused the failure.", sourceIds: ["run-1"], confidence: 0.92 },
    hypothesis: { statement: "The generator was skipped.", successMetric: "generated file exists" },
    experimentSkippedReason: "No trusted sandbox attestation.",
  };
  const signal = new AbortController().signal;
  await recordLearning(input, signal);
  await recordLearning(input, signal);
  assert.equal(entries.size, 1);
  const [entry] = [...entries.values()];
  assert.equal(entry?.project, "project-tenant-7");
  assert.equal(entry?.kind, "decision");
  assert.match(entry?.content ?? "", /No trusted sandbox attestation/);
});

test("project memory recorder rejects missing project scope", async () => {
  const store: ProjectMemoryStore = {
    save: async () => undefined,
    list: async () => [],
    find: async () => [],
  };
  const recordLearning = createProjectMemoryLearningRecorder(store, () => " ");
  await assert.rejects(() => recordLearning({
    principalId: "tenant-7",
    idempotencyKey: "autonomy-job:job-abc:1",
    question: "q",
    finding: { summary: "f", sourceIds: [], confidence: 0.5 },
    hypothesis: { statement: "h", successMetric: "m" },
  }, new AbortController().signal), /project scope/i);
});
