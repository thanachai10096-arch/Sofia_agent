import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { VersionedSkillLifecycle } from "./skill-lifecycle.js";
import { InMemorySkillsPlatform } from "../skills/platform.js";
import type { SkillPackage } from "../skills/platform.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const packageForTest: SkillPackage = {
  skill: {
    id: "learned:race:runtime_error",
    name: "Race test skill",
    description: "Tests concurrent lifecycle evaluation.",
    triggers: ["race"],
    categories: ["runtime_error"],
    strategy: "fix-implementation",
    procedure: ["inspect trusted evidence", "run verification"],
    verification: ["test"],
  },
  source: "learned",
  version: "1.0.0",
  publisher: "sofia-test",
};

test("late concurrent evaluation cannot overwrite a promoted active version", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-skill-lifecycle-race-"));
  try {
    const gates = [deferred<void>(), deferred<void>()];
    const bothStarted = deferred<void>();
    let calls = 0;
    const lifecycle = new VersionedSkillLifecycle(
      new InMemorySkillsPlatform(),
      async () => {
        const index = calls++;
        if (index === 1) bothStarted.resolve();
        await gates[index]!.promise;
        return { passed: true, checks: [{ name: "trusted-test", passed: true }] };
      },
      { file: path.join(directory, "lifecycle.json") },
    );

    const candidate = lifecycle.propose(packageForTest, {
      source: "concurrency-test",
      evidenceIds: ["test-evidence"],
      confidence: 0.95,
    });

    const firstEvaluation = lifecycle.evaluate(candidate.id);
    const secondEvaluation = lifecycle.evaluate(candidate.id);
    await bothStarted.promise;

    gates[0]!.resolve();
    const evaluated = await firstEvaluation;
    assert.equal(evaluated.status, "verified");

    const promoted = lifecycle.promote(candidate.id);
    assert.equal(promoted.status, "active");

    gates[1]!.resolve();
    await assert.rejects(
      secondEvaluation,
      /changed state during evaluation/,
    );

    assert.equal(lifecycle.get(candidate.id)?.status, "active");
    assert.equal(lifecycle.active(packageForTest.skill.id)?.id, candidate.id);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
