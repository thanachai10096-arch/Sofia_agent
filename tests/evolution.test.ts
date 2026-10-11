import { test } from "node:test";
import assert from "node:assert/strict";
import { EvolutionEngine } from "../src/brain/evolution.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("skill ranking improves after verified success and declines after failure", () => {
  const engine = new EvolutionEngine();
  engine.recordSuccess("test-repair", 4, 0);
  const afterSuccess = engine.rank(["test-repair", "new-skill"])[0];
  assert.ok(afterSuccess);
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


test("skill ranking uses task-specific outcomes while retaining global evidence", () => {
  const engine = new EvolutionEngine();
  engine.recordSuccess("generalist", 3, 0, "file-write");
  engine.recordFailure("generalist", "failed in coding", "coding");
  engine.recordSuccess("coding-specialist", 2, 0, "coding");
  const ranked = engine.rank(["generalist", "coding-specialist"], "coding");
  assert.equal(ranked[0]?.id, "coding-specialist");
  assert.equal(engine.getSkill("generalist")?.taskTypes.coding?.failures, 1);
});

test("diagnostics summarizes verified skill outcomes and task types", () => {
  const engine = new EvolutionEngine();
  engine.recordSuccess("safe-skill", 2, 0, "file-write");
  engine.recordFailure("risky-skill", "verification failed", "coding");
  engine.recordFailure("risky-skill", "review rejected", "coding");
  engine.recordRun("coding", false);
  engine.recordRun("coding", false);
  const report = engine.getDiagnostics();
  assert.equal(report.totals.skills, 2);
  assert.equal(report.totals.attempts, 3);
  assert.equal(report.totals.successes, 1);
  assert.equal(report.totals.failures, 2);
  assert.equal(report.taskTypes.coding?.failures, 2);
  assert.ok(report.skillsNeedingAttention.some(skill => skill.id === "risky-skill"));
});

test("evolution state persists and reloads task-specific outcomes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sofia-evolution-"));
  const file = join(directory, "evolution.json");
  try {
    const first = new EvolutionEngine(file);
    first.recordSuccess("persisted-skill", 5, 1, "coding");
    await first.flush();
    const raw = JSON.parse(await readFile(file, "utf8")) as { skills: Record<string, { taskTypes: Record<string, { successes: number }> }> };
    assert.equal(raw.skills["persisted-skill"]?.taskTypes.coding?.successes, 1);

    const second = new EvolutionEngine(file);
    assert.equal(second.getSkill("persisted-skill")?.successes, 1);
    assert.equal(second.getSkill("persisted-skill")?.taskTypes.coding?.successes, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy evolution snapshots load with safe defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sofia-evolution-legacy-"));
  const file = join(directory, "evolution.json");
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify({
      version: 1,
      skills: { legacy: { id: "legacy", attempts: 1, successes: 1, failures: 0, confidence: 0.7, avgSteps: 2, avgRecoveryRounds: 0 } },
      taskTypes: {},
    }), "utf8");
    const engine = new EvolutionEngine(file);
    assert.deepEqual(engine.getSkill("legacy")?.taskTypes, {});
    engine.recordSuccess("legacy", 1, 0, "coding");
    assert.equal(engine.getSkill("legacy")?.taskTypes.coding?.successes, 1);
    await engine.flush();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
