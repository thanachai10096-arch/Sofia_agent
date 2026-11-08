import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { VersionedSkillLifecycle, getSkillCandidateDigest } from "../src/brain/skill-lifecycle.js";
import { InMemorySkillsPlatform } from "../src/skills/platform.js";
import type { SkillPackage } from "../src/skills/platform.js";
import { SkillBenchmarkEngine } from "../src/skills/skill-benchmark.js";

function pkg(version: string): SkillPackage {
  return { source: "learned", version, publisher: "test", skill: {
    id: "repair-skill", name: "Repair skill", description: "Fixture skill", triggers: ["bug"],
    categories: ["runtime_error"], strategy: "inspect-evidence", procedure: ["inspect", "verify"], verification: ["test"],
  } };
}
function dir(): string { return mkdtempSync(path.join(os.tmpdir(), "sofia-skill-life-")); }
const passing = async (candidate: SkillPackage) => ({
  passed: true,
  checks: [{ name: "regression", passed: true }, { name: "policy", passed: true }],
  runtimeVerification: {
    candidateDigest: getSkillCandidateDigest(candidate),
    runnerId: "test-isolated-runner",
    isolatedWorkspaceId: "test-workspace",
    isolated: true as const,
    executedChecks: candidate.skill.verification.map((name) => ({ name, passed: true })),
    completedAt: new Date().toISOString(),
  },
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

test("skill lifecycle rejects missing, blank, or duplicate provenance evidence", () => {
  const root = dir();
  try {
    const lifecycle = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, {
      file: path.join(root, "lifecycle.json"),
    });
    assert.throws(
      () => lifecycle.propose(pkg("1.0.0"), { source: "repair", evidenceIds: [], confidence: 1 }),
      /Invalid skill provenance/,
    );
    assert.throws(
      () => lifecycle.propose(pkg("1.0.1"), { source: "repair", evidenceIds: ["  "], confidence: 1 }),
      /Invalid skill provenance/,
    );
    assert.throws(
      () => lifecycle.propose(pkg("1.0.2"), { source: "repair", evidenceIds: ["e1", "e1"], confidence: 1 }),
      /Invalid skill provenance/,
    );
    assert.equal(lifecycle.list().length, 0);
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


test("skill lifecycle never promotes when runtime verification is unavailable", async () => {
  const root = dir();
  try {
    const platform = new InMemorySkillsPlatform();
    const lifecycle = new VersionedSkillLifecycle(platform, async () => ({
      passed: false,
      checks: [
        { name: "skill-metadata", passed: true },
        { name: "procedure", passed: true },
        { name: "verification-requirements", passed: true },
        { name: "runtime-verification", passed: false, detail: "No isolated verifier is configured." },
      ],
    }), { file: path.join(root, "runtime-unverified.json") });
    const candidate = lifecycle.propose(pkg("1.0.0"), {
      source: "repair", evidenceIds: ["metadata-only"], confidence: 1,
    });
    const evaluated = await lifecycle.evaluate(candidate.id);
    assert.equal(evaluated.status, "rejected");
    assert.equal(evaluated.evaluation?.passed, false);
    assert.throws(() => lifecycle.promote(candidate.id), /evaluated/);
    assert.equal(platform.get("repair-skill"), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("skill lifecycle rejects missing or mismatched isolated runtime evidence", async () => {
  const root = dir();
  try {
    const platform = new InMemorySkillsPlatform();
    const lifecycle = new VersionedSkillLifecycle(platform, async (candidate) => ({
      passed: true,
      checks: [{ name: "metadata", passed: true }],
      runtimeVerification: {
        candidateDigest: "0".repeat(64),
        runnerId: "claimed-runner",
        isolatedWorkspaceId: "claimed-workspace",
        isolated: true,
        executedChecks: candidate.skill.verification.map((name) => ({ name, passed: true })),
        completedAt: new Date().toISOString(),
      },
    }), { file: path.join(root, "mismatched-evidence.json") });
    const candidate = lifecycle.propose(pkg("1.0.0"), {
      source: "repair", evidenceIds: ["candidate-binding"], confidence: 1,
    });
    const evaluated = await lifecycle.evaluate(candidate.id);
    assert.equal(evaluated.status, "rejected");
    assert.equal(evaluated.evaluation?.passed, false);
    assert.throws(() => lifecycle.promote(candidate.id), /isolated runtime verification/);
    assert.equal(platform.get("repair-skill"), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("skill lifecycle deactivates legacy active records without isolated evidence during restore", async () => {
  const root = dir();
  try {
    const file = path.join(root, "legacy-lifecycle.json");
    const originalPlatform = new InMemorySkillsPlatform();
    const original = new VersionedSkillLifecycle(originalPlatform, passing, { file });
    const candidate = original.propose(pkg("1.0.0"), {
      source: "repair", evidenceIds: ["legacy-record"], confidence: 1,
    });
    await original.evaluate(candidate.id);
    original.promote(candidate.id);

    const persisted = JSON.parse(readFileSync(file, "utf8")) as {
      records: Array<{ evaluation?: { runtimeVerification?: unknown } }>;
    };
    delete persisted.records[0]?.evaluation?.runtimeVerification;
    writeFileSync(file, JSON.stringify(persisted), "utf8");

    const restoredPlatform = new InMemorySkillsPlatform();
    const restored = new VersionedSkillLifecycle(restoredPlatform, passing, { file });
    assert.equal(restored.active("repair-skill"), undefined);
    assert.equal(restoredPlatform.get("repair-skill"), undefined);
    assert.equal(restored.list("repair-skill")[0]?.status, "rejected");

    const migrated = JSON.parse(readFileSync(file, "utf8")) as {
      activeBySkill: Record<string, string>;
      records: Array<{ status: string; evaluation?: { passed: boolean } }>;
    };
    assert.equal(migrated.activeBySkill["repair-skill"], undefined);
    assert.equal(migrated.records[0]?.status, "rejected");
    assert.equal(migrated.records[0]?.evaluation?.passed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("skill lifecycle requires same-version benchmark evidence and blocks safety regressions", async () => {
  const root = dir();
  try {
    const engine = new SkillBenchmarkEngine();
    const baseline = engine.summarize("repair-skill", "1.0.0", [
      { fixtureId: "case-a", passed: true, safetyPassed: true, durationMs: 120, toolCalls: 1, retries: 0 },
      { fixtureId: "case-b", passed: true, safetyPassed: true, durationMs: 130, toolCalls: 1, retries: 0 },
      { fixtureId: "case-c", passed: false, safetyPassed: true, durationMs: 140, toolCalls: 2, retries: 1 },
    ]);
    engine.setBaseline(baseline);

    const platform = new InMemorySkillsPlatform();
    const lifecycle = new VersionedSkillLifecycle(platform, async (candidate) => ({
      ...await passing(candidate),
      benchmarkReport: engine.summarize("repair-skill", "1.0.0", [
        { fixtureId: "case-a", passed: true, safetyPassed: true, durationMs: 90, toolCalls: 1, retries: 0 },
        { fixtureId: "case-b", passed: true, safetyPassed: false, durationMs: 90, toolCalls: 1, retries: 0 },
        { fixtureId: "case-c", passed: true, safetyPassed: true, durationMs: 90, toolCalls: 1, retries: 0 },
      ]),
    }), { file: path.join(root, "benchmark-gated.json"), benchmarkEngine: engine });

    const candidate = lifecycle.propose(pkg("1.0.0"), {
      source: "repair", evidenceIds: ["benchmark-safety-gate"], confidence: 0.99,
    });
    const evaluated = await lifecycle.evaluate(candidate.id);
    assert.equal(evaluated.status, "rejected");
    assert.equal(evaluated.evaluation?.passed, false);
    assert.equal(evaluated.evaluation?.benchmark?.comparison.verdict, "blocked_safety");
    assert.throws(() => lifecycle.promote(candidate.id), /evaluated/);
    assert.equal(platform.get("repair-skill"), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill lifecycle with benchmark gate rejects missing baseline or mismatched version evidence", async () => {
  const root = dir();
  try {
    const engine = new SkillBenchmarkEngine();
    const lifecycle = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), async (candidate) => ({
      ...await passing(candidate),
      benchmarkReport: engine.summarize("repair-skill", "1.0.0", [
        { fixtureId: "a", passed: true, safetyPassed: true, durationMs: 1, toolCalls: 1, retries: 0 },
        { fixtureId: "b", passed: true, safetyPassed: true, durationMs: 1, toolCalls: 1, retries: 0 },
        { fixtureId: "c", passed: true, safetyPassed: true, durationMs: 1, toolCalls: 1, retries: 0 },
      ]),
    }), { file: path.join(root, "benchmark-missing.json"), benchmarkEngine: engine });
    const candidate = lifecycle.propose(pkg("1.0.0"), {
      source: "repair", evidenceIds: ["no-baseline"], confidence: 0.99,
    });
    const evaluated = await lifecycle.evaluate(candidate.id);
    assert.equal(evaluated.status, "rejected");
    assert.equal(evaluated.evaluation?.benchmark?.comparison.verdict, "insufficient_evidence");
    assert.equal(evaluated.evaluation?.checks.some((check) => check.name === "benchmark-regression" && !check.passed), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("skill lifecycle restores benchmark baseline before revalidating active skills", async () => {
  const root = dir();
  try {
    const file = path.join(root, "benchmark-restore.json");
    const engine = new SkillBenchmarkEngine();
    const baselineResults = [
      { fixtureId: "restore-a", passed: true, safetyPassed: true, durationMs: 100, toolCalls: 1, retries: 0 },
      { fixtureId: "restore-b", passed: true, safetyPassed: true, durationMs: 110, toolCalls: 1, retries: 0 },
      { fixtureId: "restore-c", passed: false, safetyPassed: true, durationMs: 120, toolCalls: 2, retries: 1 },
    ];
    engine.setBaseline(engine.summarize("repair-skill", "1.0.0", baselineResults));
    const platform = new InMemorySkillsPlatform();
    const lifecycle = new VersionedSkillLifecycle(platform, async (candidate) => ({
      ...await passing(candidate),
      benchmarkReport: engine.summarize("repair-skill", "1.0.0", baselineResults),
    }), { file, benchmarkEngine: engine });
    const candidate = lifecycle.propose(pkg("1.0.0"), {
      source: "repair", evidenceIds: ["benchmark-restore"], confidence: 0.99,
    });
    const evaluated = await lifecycle.evaluate(candidate.id);
    assert.equal(evaluated.status, "verified");
    assert.equal(evaluated.evaluation?.benchmark?.comparison.verdict, "stable");
    lifecycle.promote(candidate.id);

    const restoredEngine = new SkillBenchmarkEngine();
    const restoredPlatform = new InMemorySkillsPlatform();
    const restored = new VersionedSkillLifecycle(restoredPlatform, passing, {
      file, benchmarkEngine: restoredEngine,
    });
    assert.ok(restoredEngine.getBaseline("repair-skill", "1.0.0"));
    assert.equal(restored.active("repair-skill")?.status, "active");
    assert.equal(restoredPlatform.get("repair-skill")?.version, "1.0.0");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
