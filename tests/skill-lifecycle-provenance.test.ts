import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    categories: ["runtime_error"],
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

test("skill lifecycle bounds skill metadata collection sizes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sofia-skill-metadata-bounds-"));
  try {
    const lifecycle = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, {
      file: path.join(root, "lifecycle.json"),
    });
    const invalidPackages: SkillPackage[] = [
      { ...skillPackage, skill: { ...skillPackage.skill, triggers: Array.from({ length: 101 }, (_, i) => `trigger-${i}`) } },
      { ...skillPackage, skill: { ...skillPackage.skill, categories: Array.from({ length: 51 }, () => "runtime_error" as const) } },
      { ...skillPackage, skill: { ...skillPackage.skill, procedure: Array.from({ length: 101 }, (_, i) => `step-${i}`) } },
      { ...skillPackage, skill: { ...skillPackage.skill, verification: ["typecheck", "test", "build", "test"] } },
    ];
    for (const invalidPackage of invalidPackages) {
      assert.throws(
        () => lifecycle.propose(invalidPackage, { source: "repair", evidenceIds: ["evidence-1"], confidence: 0.9 }),
        /Invalid skill metadata/,
      );
    }
    assert.equal(lifecycle.list().length, 0, "oversized skill metadata must not create lifecycle records");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skill lifecycle rejects duplicate persisted record IDs", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sofia-skill-duplicate-record-"));
  const file = path.join(root, "lifecycle.json");
  try {
    const lifecycle = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file });
    lifecycle.propose(skillPackage, { source: "repair", evidenceIds: ["evidence-1"], confidence: 0.9 });
    const persisted = JSON.parse(readFileSync(file, "utf8")) as { records: Array<Record<string, unknown>> };
    persisted.records.push({ ...persisted.records[0] });
    writeFileSync(file, JSON.stringify(persisted));
    assert.throws(() => new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file }), /Duplicate skill lifecycle record id/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skill lifecycle rejects persisted records with missing evidence IDs", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sofia-skill-persisted-evidence-"));
  const file = path.join(root, "lifecycle.json");
  try {
    const lifecycle = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file });
    lifecycle.propose(skillPackage, { source: "repair", evidenceIds: ["evidence-1"], confidence: 0.9 });
    const persisted = JSON.parse(readFileSync(file, "utf8")) as { records: Array<{ provenance: { evidenceIds: string[] } }> };
    persisted.records[0]!.provenance.evidenceIds = [];
    writeFileSync(file, JSON.stringify(persisted));
    assert.throws(() => new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file }), /Invalid skill lifecycle record/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skill lifecycle rejects evaluator results above the check limit", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sofia-skill-evaluator-bounds-"));
  try {
    const lifecycle = new VersionedSkillLifecycle(
      new InMemorySkillsPlatform(),
      async () => ({ passed: true, checks: Array.from({ length: 101 }, () => ({ name: "check", passed: true })) }),
      { file: path.join(root, "lifecycle.json") },
    );
    const candidate = lifecycle.propose(skillPackage, { source: "verified-repair", evidenceIds: ["test-run-123"], confidence: 0.9 });
    const evaluated = await lifecycle.evaluate(candidate.id);
    assert.equal(evaluated.status, "rejected");
    assert.equal(evaluated.evaluation?.passed, false);
    assert.match(evaluated.evaluation?.checks[0]?.detail ?? "", /unbounded evidence/);
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

test("skill lifecycle rejects blank evaluator check names and oversized details", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sofia-skill-evaluator-fields-"));
  try {
    for (const [label, checks] of [
      ["blank-name", [{ name: "   ", passed: true }]],
      ["oversized-detail", [{ name: "check", passed: true, detail: "x".repeat(10_001) }]],
    ] as const) {
      const lifecycle = new VersionedSkillLifecycle(
        new InMemorySkillsPlatform(),
        async () => ({ passed: true, checks: [...checks] }),
        { file: path.join(root, label + ".json") },
      );
      const candidate = lifecycle.propose(skillPackage, {
        source: "verified-repair",
        evidenceIds: ["test-run-" + label],
        confidence: 0.9,
      });
      const evaluated = await lifecycle.evaluate(candidate.id);
      assert.equal(evaluated.status, "rejected");
      assert.equal(evaluated.evaluation?.passed, false);
      assert.match(evaluated.evaluation?.checks[0]?.detail ?? "", /unbounded evidence/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

