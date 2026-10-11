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
