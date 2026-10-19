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

test("ranking favors verified outcomes over repeated failures for the same task type", () => {
  const engine = new EvolutionEngine();

  for (let i = 0; i < 5; i++) {
    engine.recordSuccess("reliable-coding-skill", 2, 0, "coding");
    engine.recordFailure("unreliable-coding-skill", "verification failed", "coding");
  }

  const ranked = engine.rank(
    ["unreliable-coding-skill", "reliable-coding-skill"],
    "coding",
  );

  assert.equal(ranked[0]?.id, "reliable-coding-skill");
  assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));
  assert.equal(engine.getSkill("reliable-coding-skill")?.successes, 5);
  assert.equal(engine.getSkill("unreliable-coding-skill")?.failures, 5);
});

test("ranking existing skills is read-only and preserves recorded outcomes", () => {
  const engine = new EvolutionEngine();
  engine.recordSuccess("known-skill", 3, 1, "coding");
  const before = engine.getSkill("known-skill");

  engine.rank(["known-skill", "unseen-skill"], "coding");
  engine.choose(["known-skill", "unseen-skill"], "coding");

  assert.deepEqual(engine.getSkill("known-skill"), before);
  assert.equal(engine.getSkill("unseen-skill"), undefined);
  assert.equal(engine.getDiagnostics().totals.skills, 1);
  assert.equal(engine.getDiagnostics().totals.attempts, 1);
});


test("ranking prototype-like candidate IDs stays read-only", () => {
  const engine = new EvolutionEngine();
  const candidates = ["__proto__", "constructor", "toString"];

  const ranked = engine.rank(candidates, "__proto__");

  assert.deepEqual(new Set(ranked.map(item => item.id)), new Set(candidates));
  assert.equal(engine.getSkill("__proto__"), undefined);
  assert.equal(engine.getSkill("constructor"), undefined);
  assert.equal(engine.getSkill("toString"), undefined);
  assert.equal(engine.getDiagnostics().totals.skills, 0);
});
