import { test } from "node:test";
import assert from "node:assert/strict";
import { EvolutionEngine } from "../src/brain/evolution.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("ranking unknown candidates does not persist phantom skills", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sofia-evolution-ranking-only-"));
  const file = join(directory, "evolution.json");
  try {
    const engine = new EvolutionEngine(file);
    engine.rank(["unseen-coding", "unseen-research"], "coding");
    await engine.flush();

    // Ranking is read-only: with no recorded outcomes, it should not
    // create a snapshot file at all.
    await assert.rejects(
      readFile(file, "utf8"),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
