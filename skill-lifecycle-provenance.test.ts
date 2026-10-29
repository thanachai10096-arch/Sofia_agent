import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { VersionedSkillLifecycle } from "../src/brain/skill-lifecycle.js";
import { InMemorySkillsPlatform } from "../src/skills/platform.js";
import type { SkillPackage } from "../src/skills/platform.js";

const skillPackage: SkillPackage = {
  source: "learned",
  version: "1.0.0",
  publisher: "test",
  skill: {
    id: "evidence-guard-skill",
    name: "Evidence guard skill",
    description: "Fixture for provenance validation",
    triggers: ["test"],
    categories: ["testing"],
    strategy: "inspect-evidence",
    procedure: ["inspect evidence", "verify outcome"],
    verification: ["test"],
  },
};
const passing = async () => ({ passed: true, checks: [{ name: "regression", passed: true }] });

test("skill lifecycle rejects missing, blank, duplicate, and unbounded evidence IDs", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sofia-skill-evidence-"));
  try {
    const lifecycle = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, {
      file: path.join(root, "lifecycle.json"),
    });
    for (const evidenceIds of [
      [],
      ["   "],
      ["evidence-1", "evidence-1"],
      Array.from({ length: 101 }, (_, i) => `evidence-${i}`),
    ]) {
      assert.throws(
        () => lifecycle.propose(skillPackage, { source: "repair", evidenceIds, confidence: 0.9 }),
        /Invalid skill provenance/,
      );
    }
    for (const source of ["", "x".repeat(201)]) {
      assert.throws(
        () => lifecycle.propose(skillPackage, { source, evidenceIds: ["evidence-1"], confidence: 0.9 }),
        /Invalid skill provenance/,
      );
    }
    assert.equal(lifecycle.list().length, 0, "invalid provenance must not create lifecycle records");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skill lifecycle accepts bounded unique evidence and still requires successful evaluation", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sofia-skill-evidence-"));
  try {
    const lifecycle = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, {
      file: path.join(root, "lifecycle.json"),
    });
    const candidate = lifecycle.propose(skillPackage, {
      source: "verified-repair",
      evidenceIds: ["test-run-123", "build-run-456"],
      confidence: 0.9,
    });
    assert.deepEqual(candidate.provenance.evidenceIds, ["test-run-123", "build-run-456"]);
    assert.throws(() => lifecycle.promote(candidate.id), /successfully evaluated/);
    await lifecycle.evaluate(candidate.id);
    assert.equal(lifecycle.promote(candidate.id).status, "active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
