import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
