import { test } from "node:test";
import assert from "node:assert/strict";
import { EvolutionEngine } from "../src/brain/evolution.js";

test("skill ranking improves after verified success and declines after failure", () => {
  const engine = new EvolutionEngine();
  engine.recordSuccess("test-repair", 4, 0);
  const afterSuccess = engine.rank(["test-repair", "new-skill"])[0];
  assert.equal(afterSuccess.id, "test-repair");
  assert.equal(afterSuccess.successRate, 1);
  assert.equal(afterSuccess.attempts, 1);

  engine.recordFailure("test-repair", "assertion mismatch");
  const skill = engine.getSkill("test-repair");
  assert.ok(skill);
  assert.equal(skill.successes, 1);
  assert.equal(skill.failures, 1);
  assert.equal(skill.attempts, 2);
  assert.equal(skill.failureHistory.at(-1)?.message, "assertion mismatch");
  assert.equal(skill.successHistory.length, 1);
});

test("run-level task type statistics track success and failure", () => {
  const engine = new EvolutionEngine();
  engine.recordRun("coding", true);
  engine.recordRun("coding", false);
  const stats = engine.getSnapshot().taskTypes.coding;
  assert.deepEqual(stats, { attempts: 2, successes: 1, failures: 1 });
});

test("history is bounded to the most recent twenty outcomes", () => {
  const engine = new EvolutionEngine();
  for (let i = 0; i < 25; i++) engine.recordFailure("network-repair", "failure " + i);
  const skill = engine.getSkill("network-repair");
  assert.ok(skill);
  assert.equal(skill.failureHistory.length, 20);
  assert.equal(skill.failureHistory[0]?.message, "failure 5");
});


test("task-specific ranking rewards skills with relevant verified outcomes", () => {
  const engine = new EvolutionEngine();
  engine.recordSuccess("typescript-fix", 3, 0, "coding");
  engine.recordSuccess("typescript-fix", 4, 0, "coding");
  engine.recordFailure("typescript-fix", "browser timeout", "browser");
  const coding = engine.rank(["typescript-fix", "new-skill"], "coding");
  const browser = engine.rank(["typescript-fix", "new-skill"], "browser");
  assert.equal(coding[0]?.id, "typescript-fix");
  assert.ok(coding[0]!.score > browser[0]!.score);
});

test("evolution persistence survives a reload", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "sofia-evolution-"));
  const file = join(directory, "evolution.json");
  try {
    const first = new EvolutionEngine(file);
    first.recordSuccess("durable-skill", 2, 1, "coding");
    await first.flush();
    const second = new EvolutionEngine(file);
    assert.equal(second.getSkill("durable-skill")?.successes, 1);
    assert.equal(second.getSkill("durable-skill")?.avgSteps, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("skill snapshots cannot mutate the engine's internal history", () => {
  const engine = new EvolutionEngine();
  engine.recordFailure("isolated-skill", "known failure");
  const snapshot = engine.getSkill("isolated-skill");
  snapshot?.failureHistory.splice(0, 1);
  assert.equal(engine.getSkill("isolated-skill")?.failureHistory.length, 1);
});
