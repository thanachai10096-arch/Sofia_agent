import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EvolutionEngine } from "./evolution.js";

test("EvolutionEngine persists evidence and reloads task-specific skill outcomes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sofia-evolution-"));
  const file = path.join(directory, "evolution.json");
  try {
    const engine = new EvolutionEngine(file);
    engine.recordSuccess("typescript-repair", 4, 1, "typescript");
    engine.recordFailure("typescript-repair", "typecheck failed", "typescript");
    engine.recordSuccess("research", 2, 0, "research");
    await engine.flush();

    const persisted = JSON.parse(await readFile(file, "utf8")) as {
      skills: Record<string, { attempts: number; successes: number; failures: number }>;
    };
    assert.deepEqual(
      {
        attempts: persisted.skills["typescript-repair"]?.attempts,
        successes: persisted.skills["typescript-repair"]?.successes,
        failures: persisted.skills["typescript-repair"]?.failures,
      },
      { attempts: 2, successes: 1, failures: 1 },
    );

    const reloaded = new EvolutionEngine(file);
    assert.equal(reloaded.getSkill("typescript-repair")?.attempts, 2);
    assert.equal(reloaded.getSkill("typescript-repair")?.taskTypes.typescript?.failures, 1);
    assert.equal(reloaded.getSkill("research")?.successes, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("EvolutionEngine ranks skills with task-specific evidence without over-trusting one success", () => {
  const engine = new EvolutionEngine();
  engine.recordSuccess("new-skill", 1, 0, "typescript");
  engine.recordFailure("proven-skill", "one failure", "typescript");
  engine.recordSuccess("proven-skill", 2, 0, "typescript");
  engine.recordSuccess("proven-skill", 2, 0, "typescript");
  const ranked = engine.rank(["new-skill", "proven-skill"], "typescript");

  assert.equal(ranked.length, 2);
  assert.ok(ranked.every((item) => Number.isFinite(item.score)));
  assert.ok(ranked.find((item) => item.id === "new-skill")!.successRate < 1);
  assert.equal(ranked.find((item) => item.id === "proven-skill")!.attempts, 3);
});

test("EvolutionEngine redacts secrets from recorded failure evidence", () => {
  const engine = new EvolutionEngine();
  const marker = "private-token-marker-123456";
  engine.recordFailure("api-skill", "provider failed with token=" + marker, "api");
  const skill = engine.getSkill("api-skill");
  assert.ok(skill?.lastFailure);
  assert.doesNotMatch(skill.lastFailure, new RegExp(marker));
});
