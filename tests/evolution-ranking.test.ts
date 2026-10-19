import { test } from "node:test";
import assert from "node:assert/strict";
import { EvolutionEngine } from "../src/brain/evolution.js";

test("ranking an unknown candidate does not register a phantom learned skill", () => {
  const engine = new EvolutionEngine();

  const ranked = engine.rank(["candidate-not-yet-observed"], "coding");

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.id, "candidate-not-yet-observed");
  assert.equal(engine.getSkill("candidate-not-yet-observed"), undefined);
  assert.equal(engine.getDiagnostics().totals.skills, 0);
});

test("diagnostics stay empty after ranking only unobserved candidates", () => {
  const engine = new EvolutionEngine();

  engine.rank(["unseen-a", "unseen-b"], "research");

  const diagnostics = engine.getDiagnostics();
  assert.equal(diagnostics.totals.skills, 0);
  assert.equal(diagnostics.totals.attempts, 0);
  assert.equal(diagnostics.totals.successes, 0);
  assert.equal(diagnostics.totals.failures, 0);
});
