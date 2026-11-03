import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { VersionedSkillLifecycle } from "../src/brain/skill-lifecycle.js";
import { InMemorySkillsPlatform } from "../src/skills/platform.js";
import type { SkillPackage } from "../src/skills/platform.js";

function pkg(version: string): SkillPackage {
  return { source: "learned", version, publisher: "test", skill: {
    id: "repair-skill", name: "Repair skill", description: "Fixture skill", triggers: ["bug"],
    categories: ["runtime_error"], strategy: "inspect-evidence", procedure: ["inspect", "verify"], verification: ["test"],
  } };
}
function dir(): string { return mkdtempSync(path.join(os.tmpdir(), "sofia-skill-life-")); }
const passing = async () => ({ passed: true, checks: [{ name: "regression", passed: true }, { name: "policy", passed: true }] });

test("skill lifecycle rejects missing, blank, duplicate, or oversized provenance evidence", () => {
  const root = dir();
  try {
    const lifecycle = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file: path.join(root, "lifecycle.json") });
    const invalid = [
      [],
      [""],
      ["   "],
      ["evidence-1", "evidence-1"],
      ["e".repeat(501)],
    ];
    for (const evidenceIds of invalid) {
      assert.throws(
        () => lifecycle.propose(pkg("1.0.0"), { source: "repair", evidenceIds, confidence: 0.9 }),
        /Invalid skill provenance/,
      );
    }
    assert.equal(lifecycle.list().length, 0, "invalid provenance must not create persisted candidates");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("separate lifecycle instances reload under the writer lock and preserve each other's candidates", () => {
  const root = dir();
  try {
    const file = path.join(root, "shared", "lifecycle.json");
    const firstWriter = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file });
    const secondWriter = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file });

    const first = firstWriter.propose(pkg("1.0.0"), {
      source: "writer-one", evidenceIds: ["writer-one-evidence"], confidence: 0.9,
    });
    const evaluatedBySecondInstance = await secondWriter.evaluate(first.id);
    assert.equal(evaluatedBySecondInstance.status, "verified", "a stale instance must refresh before looking up a candidate");
    const second = secondWriter.propose({ ...pkg("1.0.1"), skill: { ...pkg("1.0.1").skill, id: "second-skill" } }, {
      source: "writer-two", evidenceIds: ["writer-two-evidence"], confidence: 0.9,
    });

    const refreshedWriter = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file });
    assert.deepEqual(refreshedWriter.list().map(item => item.id).sort(), [first.id, second.id].sort());
    assert.equal(refreshedWriter.get(first.id)?.status, "verified");

    const lockDirectory = file + ".lock";
    mkdirSync(lockDirectory);
    assert.throws(
      () => refreshedWriter.propose(pkg("1.0.2"), {
        source: "blocked-writer", evidenceIds: ["blocked"], confidence: 0.9,
      }),
      /locked by another writer/i,
    );
    rmSync(lockDirectory, { recursive: true, force: true });
    assert.equal(refreshedWriter.list().length, 2, "a rejected writer must not alter persisted candidates");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill lifecycle requires evaluation and confidence before promotion", async () => {
  const root = dir();
  try {
    const platform = new InMemorySkillsPlatform();
    const lifecycle = new VersionedSkillLifecycle(platform, passing, { file: path.join(root, "lifecycle.json"), minimumConfidence: 0.8 });
    const candidate = lifecycle.propose(pkg("1.0.0"), { source: "repair", evidenceIds: ["test-1"], confidence: 0.9 });
    assert.throws(() => lifecycle.promote(candidate.id), /evaluated/);
    await lifecycle.evaluate(candidate.id);
    lifecycle.promote(candidate.id);
    assert.equal(platform.get("repair-skill")?.version, "1.0.0");
    assert.equal(lifecycle.active("repair-skill")?.status, "active");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stale concurrent evaluation cannot overwrite a promoted active candidate", async () => {
  const root = dir();
  try {
    const pending: Array<(value: { passed: boolean; checks: Array<{ name: string; passed: boolean }> }) => void> = [];
    const lifecycle = new VersionedSkillLifecycle(
      new InMemorySkillsPlatform(),
      async () => new Promise(resolve => pending.push(resolve)),
      { file: path.join(root, "concurrent.json") },
    );
    const candidate = lifecycle.propose(pkg("1.0.0"), {
      source: "repair", evidenceIds: ["concurrent-evidence"], confidence: 0.95,
    });

    const firstEvaluation = lifecycle.evaluate(candidate.id);
    const staleEvaluation = lifecycle.evaluate(candidate.id);
    assert.equal(pending.length, 2, "both evaluations should be in flight");

    pending[0]!({ passed: true, checks: [{ name: "regression", passed: true }] });
    await firstEvaluation;
    lifecycle.promote(candidate.id);
    assert.equal(lifecycle.active("repair-skill")?.status, "active");

    pending[1]!({ passed: true, checks: [{ name: "regression", passed: true }] });
    await assert.rejects(staleEvaluation, /changed state during evaluation/i);
    assert.equal(lifecycle.active("repair-skill")?.status, "active");
    assert.equal(lifecycle.get(candidate.id)?.status, "active");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("separate lifecycle instances reject an evaluation made stale by another writer promotion", async () => {
  const root = dir();
  try {
    const file = path.join(root, "shared-concurrent.json");
    const platform = new InMemorySkillsPlatform();
    const pending: Array<(value: { passed: boolean; checks: Array<{ name: string; passed: boolean }> }) => void> = [];
    const firstWriter = new VersionedSkillLifecycle(
      platform,
      async () => new Promise(resolve => pending.push(resolve)),
      { file },
    );
    const secondWriter = new VersionedSkillLifecycle(platform, passing, { file });
    const candidate = firstWriter.propose(pkg("1.0.0"), {
      source: "cross-instance", evidenceIds: ["cross-instance-evidence"], confidence: 0.95,
    });

    const staleEvaluation = firstWriter.evaluate(candidate.id);
    assert.equal(pending.length, 1);
    const freshEvaluation = await secondWriter.evaluate(candidate.id);
    assert.equal(freshEvaluation.status, "verified");
    secondWriter.promote(candidate.id);
    assert.equal(platform.get("repair-skill")?.version, "1.0.0");

    pending[0]!({ passed: true, checks: [{ name: "regression", passed: true }] });
    await assert.rejects(staleEvaluation, /changed state during evaluation/i);
    const refreshed = new VersionedSkillLifecycle(platform, passing, { file });
    assert.equal(refreshed.active("repair-skill")?.status, "active");
    assert.equal(refreshed.list().filter(item => item.status === "active").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill lifecycle rejects failed evaluations and low-confidence promotion", async () => {
  const root = dir();
  try {
    const platform = new InMemorySkillsPlatform();
    const failing = new VersionedSkillLifecycle(platform, async () => ({ passed: true, checks: [{ name: "regression", passed: false }] }), { file: path.join(root, "failed.json") });
    const candidate = failing.propose(pkg("1.0.0"), { source: "repair", evidenceIds: ["test-2"], confidence: 1 });
    const evaluated = await failing.evaluate(candidate.id);
    assert.equal(evaluated.status, "rejected");
    assert.throws(() => failing.promote(candidate.id), /evaluated/);

    const low = new VersionedSkillLifecycle(platform, passing, { file: path.join(root, "low.json"), minimumConfidence: 0.8 });
    const lowCandidate = low.propose(pkg("1.0.1"), { source: "repair", evidenceIds: ["test-3"], confidence: 0.4 });
    await low.evaluate(lowCandidate.id);
    assert.throws(() => low.promote(lowCandidate.id), /confidence/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill lifecycle preserves prior version and can roll back", async () => {
  const root = dir();
  try {
    const file = path.join(root, "lifecycle.json");
    const platform = new InMemorySkillsPlatform();
    const lifecycle = new VersionedSkillLifecycle(platform, passing, { file });
    const first = lifecycle.propose(pkg("1.0.0"), { source: "repair", evidenceIds: ["e1"], confidence: 0.9 });
    await lifecycle.evaluate(first.id); lifecycle.promote(first.id);
    const second = lifecycle.propose(pkg("2.0.0"), { source: "repair", evidenceIds: ["e2"], confidence: 0.9 });
    await lifecycle.evaluate(second.id); lifecycle.promote(second.id);
    assert.equal(platform.get("repair-skill")?.version, "2.0.0");
    lifecycle.rollback("repair-skill");
    assert.equal(platform.get("repair-skill")?.version, "1.0.0");
    const reloaded = new VersionedSkillLifecycle(platform, passing, { file });
    assert.equal(reloaded.active("repair-skill")?.package.version, "1.0.0");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("skill lifecycle refuses to overwrite an unmanaged platform skill", async () => {
  const root = dir();
  try {
    const platform = new InMemorySkillsPlatform();
    const existing = { ...pkg("0.9.0"), source: "custom" as const };
    platform.register(existing);
    const lifecycle = new VersionedSkillLifecycle(platform, passing, { file: path.join(root, "lifecycle.json") });
    const candidate = lifecycle.propose(pkg("1.0.0"), {
      source: "repair",
      evidenceIds: ["unmanaged-collision"],
      confidence: 0.95,
    });
    await lifecycle.evaluate(candidate.id);

    assert.throws(() => lifecycle.promote(candidate.id), /Cannot promote over an unmanaged skill/);
    assert.equal(platform.get("repair-skill")?.version, "0.9.0");
    assert.equal(platform.get("repair-skill")?.source, "custom");
    assert.equal(lifecycle.active("repair-skill"), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("skill lifecycle refuses to restore persisted active state over a conflicting platform skill", async () => {
  const root = dir();
  try {
    const file = path.join(root, "lifecycle.json");
    const originalPlatform = new InMemorySkillsPlatform();
    const lifecycle = new VersionedSkillLifecycle(originalPlatform, passing, { file });
    const candidate = lifecycle.propose(pkg("1.0.0"), {
      source: "repair",
      evidenceIds: ["restore-collision"],
      confidence: 0.95,
    });
    await lifecycle.evaluate(candidate.id);
    lifecycle.promote(candidate.id);

    const conflictingPlatform = new InMemorySkillsPlatform();
    conflictingPlatform.register({ ...pkg("0.9.0"), source: "custom" });
    assert.throws(
      () => new VersionedSkillLifecycle(conflictingPlatform, passing, { file }),
      /Cannot restore active lifecycle skill over a different platform skill/,
    );
    assert.equal(conflictingPlatform.get("repair-skill")?.version, "0.9.0");
    assert.equal(conflictingPlatform.get("repair-skill")?.source, "custom");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("skill lifecycle validates all persisted active skills before mutating the platform", async () => {
  const root = dir();
  try {
    const file = path.join(root, "lifecycle.json");
    const originalPlatform = new InMemorySkillsPlatform();
    const lifecycle = new VersionedSkillLifecycle(originalPlatform, passing, { file });
    const first = lifecycle.propose(pkg("1.0.0"), {
      source: "repair", evidenceIds: ["first"], confidence: 0.95,
    });
    await lifecycle.evaluate(first.id);
    lifecycle.promote(first.id);

    const secondPackage = { ...pkg("1.0.0"), skill: { ...pkg("1.0.0").skill, id: "second-skill" } };
    const second = lifecycle.propose(secondPackage, {
      source: "repair", evidenceIds: ["second"], confidence: 0.95,
    });
    await lifecycle.evaluate(second.id);
    lifecycle.promote(second.id);

    const conflictingPlatform = new InMemorySkillsPlatform();
    conflictingPlatform.register({ ...pkg("0.9.0"), source: "custom", skill: { ...pkg("0.9.0").skill, id: "second-skill" } });
    assert.throws(
      () => new VersionedSkillLifecycle(conflictingPlatform, passing, { file }),
      /Cannot restore active lifecycle skill over a different platform skill/,
    );
    assert.equal(conflictingPlatform.get("repair-skill"), undefined, "failed restore must not partially register earlier active skills");
    assert.equal(conflictingPlatform.get("second-skill")?.version, "0.9.0");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
