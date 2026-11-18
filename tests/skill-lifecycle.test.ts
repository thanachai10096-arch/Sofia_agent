import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const first = lifecycle.propose({ ...pkg("1.0.0"), source: "custom" }, { source: "repair", evidenceIds: ["e1"], confidence: 0.9 });
    await lifecycle.evaluate(first.id); lifecycle.promote(first.id);
    const second = lifecycle.propose({ ...pkg("2.0.0"), source: "custom" }, { source: "repair", evidenceIds: ["e2"], confidence: 0.9 });
    await lifecycle.evaluate(second.id); lifecycle.promote(second.id);
    assert.equal(platform.get("repair-skill")?.version, "2.0.0");
    lifecycle.rollback("repair-skill");
    assert.equal(platform.get("repair-skill")?.version, "1.0.0");
    const reloaded = new VersionedSkillLifecycle(platform, passing, { file });
    assert.equal(reloaded.active("repair-skill")?.package.version, "1.0.0");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("skill lifecycle refuses rollback to a learned skill without fresh durable evidence", async () => {
  const root = dir();
  try {
    const platform = new InMemorySkillsPlatform();
    const lifecycle = new VersionedSkillLifecycle(platform, passing, { file: path.join(root, "lifecycle.json") });
    const learned = lifecycle.propose(pkg("1.0.0"), { source: "repair", evidenceIds: ["learned-1"], confidence: 0.9 });
    await lifecycle.evaluate(learned.id);
    lifecycle.promote(learned.id);

    const managed = lifecycle.propose({ ...pkg("2.0.0"), source: "custom" }, {
      source: "repair", evidenceIds: ["custom-2"], confidence: 0.9,
    });
    await lifecycle.evaluate(managed.id);
    lifecycle.promote(managed.id);

    assert.equal(platform.get("repair-skill")?.version, "2.0.0");
    assert.throws(
      () => lifecycle.rollback("repair-skill"),
      /Cannot roll back to a learned skill without fresh durable-evidence verification/,
    );
    assert.equal(platform.get("repair-skill")?.version, "2.0.0");
    assert.equal(lifecycle.active("repair-skill")?.id, managed.id);
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


test("skill lifecycle requires non-empty, non-blank, unique evidence identifiers", () => {
  const root = dir();
  try {
    const lifecycle = new VersionedSkillLifecycle(
      new InMemorySkillsPlatform(),
      passing,
      { file: path.join(root, "evidence.json") },
    );
    assert.throws(
      () => lifecycle.propose(pkg("1.0.0"), { source: "repair", evidenceIds: [], confidence: 0.9 }),
      /Invalid skill provenance/,
    );
    assert.throws(
      () => lifecycle.propose(pkg("1.0.0"), { source: "repair", evidenceIds: ["  "], confidence: 0.9 }),
      /Invalid skill provenance/,
    );
    assert.throws(
      () => lifecycle.propose(pkg("1.0.0"), { source: "repair", evidenceIds: ["e1", "e1"], confidence: 0.9 }),
      /Invalid skill provenance/,
    );
    const accepted = lifecycle.propose(pkg("1.0.0"), {
      source: "verified-repair",
      evidenceIds: ["verification-run-1", "test-report-1"],
      confidence: 0.9,
    });
    assert.equal(accepted.status, "candidate");
    assert.deepEqual(accepted.provenance.evidenceIds, ["verification-run-1", "test-report-1"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("persisted learned skills with even a non-empty forged runId are quarantined on reload", async () => {
  const root = dir();
  try {
    const file = path.join(root, "legacy.json");
    const originalPlatform = new InMemorySkillsPlatform();
    const lifecycle = new VersionedSkillLifecycle(originalPlatform, passing, { file });
    const candidate = lifecycle.propose(pkg("1.0.0"), {
      source: "verified-brain-repair",
      evidenceIds: ["legacy-evidence"],
      confidence: 0.95,
      runId: "forged-but-non-empty-run-id",
    });
    await lifecycle.evaluate(candidate.id);
    lifecycle.promote(candidate.id);
    assert.equal(originalPlatform.get("repair-skill")?.version, "1.0.0");

    const restoredPlatform = new InMemorySkillsPlatform();
    const restored = new VersionedSkillLifecycle(restoredPlatform, passing, { file });
    assert.equal(restored.active("repair-skill"), undefined);
    assert.equal(restoredPlatform.get("repair-skill"), undefined);
    assert.equal(restored.list("repair-skill")[0]?.status, "rejected");
    assert.equal(restored.list("repair-skill")[0]?.evaluation?.checks[0]?.name, "startup-evidence-quarantine");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("persisted verified learned skills cannot be promoted from cached evaluation after restart", async () => {
  const root = dir();
  try {
    const file = path.join(root, "verified-learned.json");
    const firstPlatform = new InMemorySkillsPlatform();
    const first = new VersionedSkillLifecycle(firstPlatform, passing, { file });
    const candidate = first.propose({ ...pkg("1.0.0"), source: "learned" }, {
      source: "verified-brain-repair",
      evidenceIds: ["e1", "e2", "e3"],
      confidence: 0.95,
      runId: "brain-run",
      skillDigest: "a".repeat(64),
    });
    const verified = await first.evaluate(candidate.id);
    assert.equal(verified.status, "verified");

    const restored = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file });
    const quarantined = restored.list("repair-skill").find((item) => item.id === candidate.id);
    assert.equal(quarantined?.status, "rejected");
    assert.equal(quarantined?.evaluation?.checks[0]?.name, "startup-evidence-quarantine");
    assert.throws(() => restored.promote(candidate.id), /Only successfully evaluated candidates can be promoted/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("restart quarantines superseded learned skills so rollback cannot reactivate them", async () => {
  const root = dir();
  try {
    const file = path.join(root, "superseded-learned.json");
    const firstPlatform = new InMemorySkillsPlatform();
    const first = new VersionedSkillLifecycle(firstPlatform, passing, { file });
    const learned = first.propose(pkg("1.0.0"), {
      source: "verified-brain-repair",
      evidenceIds: ["learned-evidence"],
      confidence: 0.95,
      runId: "brain-run",
      skillDigest: "b".repeat(64),
    });
    await first.evaluate(learned.id);
    first.promote(learned.id);

    const replacement = first.propose({ ...pkg("2.0.0"), source: "custom" }, {
      source: "manual", evidenceIds: ["manual-evidence"], confidence: 0.95,
    });
    await first.evaluate(replacement.id);
    first.promote(replacement.id);
    assert.equal(first.get(learned.id)?.status, "superseded");

    const restoredPlatform = new InMemorySkillsPlatform();
    const restored = new VersionedSkillLifecycle(restoredPlatform, passing, { file });
    assert.equal(restored.get(learned.id)?.status, "rejected");
    assert.equal(restoredPlatform.get("repair-skill")?.version, "2.0.0");
    assert.throws(() => restored.rollback("repair-skill"), /No previous version is available/);
    assert.equal(restoredPlatform.get("repair-skill")?.version, "2.0.0");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("skill lifecycle rejects duplicate persisted record IDs and invalid evidence provenance", async () => {
  const root = dir();
  try {
    const file = path.join(root, "duplicate-records.json");
    const lifecycle = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file });
    const candidate = lifecycle.propose(pkg("1.0.0"), {
      source: "repair", evidenceIds: ["evidence-1"], confidence: 0.9,
    });
    const persisted = JSON.parse(readFileSync(file, "utf8")) as {
      records: Array<Record<string, unknown>>;
    };
    persisted.records.push({ ...persisted.records[0] });
    writeFileSync(file, JSON.stringify(persisted), "utf8");
    assert.throws(
      () => new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file }),
      /Duplicate skill lifecycle record id/,
    );

    persisted.records = [persisted.records[0]!];
    const provenance = persisted.records[0]!.provenance as Record<string, unknown>;
    provenance.evidenceIds = [" ", " "];
    writeFileSync(file, JSON.stringify(persisted), "utf8");
    assert.throws(
      () => new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file }),
      /Invalid skill lifecycle provenance evidence/,
    );
    assert.equal(candidate.status, "candidate");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("concurrent evaluation requests for one candidate share a single evaluator run", async () => {
  const root = dir();
  try {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lifecycle = new VersionedSkillLifecycle(
      new InMemorySkillsPlatform(),
      async () => {
        calls += 1;
        await gate;
        return { passed: true, checks: [{ name: "single-evaluation", passed: true }] };
      },
      { file: path.join(root, "concurrent-evaluation.json") },
    );
    const candidate = lifecycle.propose(pkg("1.0.0"), {
      source: "repair", evidenceIds: ["concurrent-evidence"], confidence: 0.9,
    });
    const first = lifecycle.evaluate(candidate.id);
    const second = lifecycle.evaluate(candidate.id);
    assert.equal(calls, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, "verified");
    assert.equal(b.status, "verified");
    assert.equal(a.id, b.id);
    assert.equal(calls, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
