import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { VersionedSkillLifecycle, getSkillCandidateDigest } from "../src/brain/skill-lifecycle.js";
import { InMemorySkillsPlatform } from "../src/skills/platform.js";
import type { SkillPackage, SkillsPlatform } from "../src/skills/platform.js";
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

test("skill lifecycle refuses a symbolic-link store without modifying its target", () => {
  const root = dir();
  try {
    const target = path.join(root, "trusted.json");
    const link = path.join(root, "lifecycle.json");
    const original = JSON.stringify({ schemaVersion: 1, records: [], activeBySkill: {} });
    writeFileSync(target, original, "utf8");
    symlinkSync(target, link);

    assert.throws(
      () => new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file: link }),
      /must not be a symbolic link/,
    );
    assert.equal(readFileSync(target, "utf8"), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill lifecycle rejects corrupt persisted JSON without restoring platform entries", () => {
  const root = dir();
  try {
    const file = path.join(root, "corrupt.json");
    writeFileSync(file, "{not-json", "utf8");
    const platform = new InMemorySkillsPlatform();
    assert.throws(() => new VersionedSkillLifecycle(platform, passing, { file }));
    assert.equal(platform.list().length, 0);
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

test("skill artifacts cannot promote without trusted verification suite provenance", async () => {
  const root = dir();
  try {
    const lifecycle = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, {
      file: path.join(root, "artifact.json"),
    });
    const executable = {
      ...pkg("1.0.0"),
      artifact: {
        format: "sofia-node-skill-v1" as const,
        runtime: "node" as const,
        entrypoint: "index.js",
        files: { "index.js": "export function run() { return 1; }" },
      },
    };
    const candidate = lifecycle.propose(executable, {
      source: "repair", evidenceIds: ["artifact-evidence"], confidence: 1,
    });
    const evaluated = await lifecycle.evaluate(candidate.id);
    assert.equal(evaluated.status, "rejected");
    assert.equal(evaluated.evaluation?.passed, false);
    assert.throws(() => lifecycle.promote(candidate.id), /valid isolated runtime verification/);
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


test("failed rollback restores a missing platform entry instead of leaving a partial registration", async () => {
  const root = dir();
  try {
    const file = path.join(root, "lifecycle.json");
    const platform = new InMemorySkillsPlatform();
    const lifecycle = new VersionedSkillLifecycle(platform, passing, { file });
    const first = lifecycle.propose(pkg("1.0.0"), { source: "repair", evidenceIds: ["rollback-failure-1"], confidence: 0.9 });
    await lifecycle.evaluate(first.id);
    lifecycle.promote(first.id);
    const second = lifecycle.propose(pkg("2.0.0"), { source: "repair", evidenceIds: ["rollback-failure-2"], confidence: 0.9 });
    await lifecycle.evaluate(second.id);
    lifecycle.promote(second.id);

    // Simulate a missing platform entry and force persistence to fail after
    // rollback has attempted to register the previous version.
    platform.remove("repair-skill");
    rmSync(file);
    mkdirSync(file);

    assert.throws(() => lifecycle.rollback("repair-skill"));
    assert.equal(platform.get("repair-skill"), undefined, "failed rollback must not leave a partial platform registration");
    assert.equal(lifecycle.active("repair-skill")?.package.version, "2.0.0", "in-memory lifecycle state must remain on the original active version");
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


test("skill lifecycle compensates partial platform registration when restore fails", async () => {
  const root = dir();
  try {
    const file = path.join(root, "restore-atomic.json");
    const sourcePlatform = new InMemorySkillsPlatform();
    const source = new VersionedSkillLifecycle(sourcePlatform, passing, { file });
    const firstPackage = pkg("1.0.0");
    const secondPackage = { ...pkg("1.0.0"), skill: { ...pkg("1.0.0").skill, id: "another-skill" } };
    for (const candidatePackage of [firstPackage, secondPackage]) {
      const candidate = source.propose(candidatePackage, {
        source: "repair", evidenceIds: [candidatePackage.skill.id], confidence: 0.95,
      });
      await source.evaluate(candidate.id);
      source.promote(candidate.id);
    }

    const backing = new InMemorySkillsPlatform();
    let registrations = 0;
    const flakyPlatform: SkillsPlatform = {
      get: (id) => backing.get(id),
      list: (sourceName) => backing.list(sourceName),
      remove: (id) => backing.remove(id),
      register: (skill) => {
        registrations += 1;
        if (registrations === 2) throw new Error("simulated platform registration failure");
        backing.register(skill);
      },
    };

    assert.throws(
      () => new VersionedSkillLifecycle(flakyPlatform, passing, { file }),
      /simulated platform registration failure/,
    );
    assert.equal(backing.get("repair-skill"), undefined, "first restored skill must be compensated");
    assert.equal(backing.get("another-skill"), undefined, "failed skill must not appear in platform");
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


test("artifact verification cannot satisfy typecheck with syntax and test evidence", async () => {
  const root = dir();
  try {
    const platform = new InMemorySkillsPlatform();
    const lifecycle = new VersionedSkillLifecycle(platform, async (candidate) => ({
      passed: true,
      checks: [{ name: "metadata", passed: true }],
      runtimeVerification: {
        candidateDigest: getSkillCandidateDigest(candidate),
        runnerId: "test-isolated-runner",
        isolatedWorkspaceId: "test-workspace",
        isolated: true,
        executedChecks: [
          { name: "syntax", passed: true },
          { name: "test", passed: true },
        ],
        completedAt: new Date().toISOString(),
        testSuiteId: "operator-suite",
        testSuiteVersion: "1",
        testSuiteDigest: "a".repeat(64),
      },
    }), { file: path.join(root, "unsupported-check.json") });
    const candidate = lifecycle.propose({
      ...pkg("1.0.0"),
      skill: { ...pkg("1.0.0").skill, verification: ["typecheck"] },
      artifact: {
        format: "sofia-node-skill-v1",
        runtime: "node",
        entrypoint: "index.mjs",
        files: { "index.mjs": "export function run() { return 1; }" },
      },
    }, { source: "repair", evidenceIds: ["unsupported-typecheck"], confidence: 1 });

    const evaluated = await lifecycle.evaluate(candidate.id);
    assert.equal(evaluated.status, "rejected");
    assert.equal(evaluated.evaluation?.passed, false);
    assert.equal(
      evaluated.evaluation?.checks.some((check) => check.name === "runtime-verification" && !check.passed),
      true,
    );
    assert.match(
      evaluated.evaluation?.checks.find((check) => check.name === "runtime-verification")?.detail ?? "",
      /does not satisfy every declared verification requirement/,
    );
    assert.throws(() => lifecycle.promote(candidate.id), /valid isolated runtime verification/);
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


test("skill lifecycle rejects symbolic-link ancestors and files before loading persisted state", () => {
  const root = dir();
  try {
    const realDirectory = path.join(root, "real");
    const linkedDirectory = path.join(root, "linked");
    mkdirSync(realDirectory);
    symlinkSync(realDirectory, linkedDirectory, "dir");

    assert.throws(
      () => new VersionedSkillLifecycle(
        new InMemorySkillsPlatform(),
        passing,
        { file: path.join(linkedDirectory, "lifecycle.json") },
      ),
      /must not contain symbolic links/,
    );

    const externalFile = path.join(realDirectory, "external.json");
    const linkedFile = path.join(root, "linked-file.json");
    writeFileSync(externalFile, JSON.stringify({ schemaVersion: 1, records: [], activeBySkill: {} }));
    symlinkSync(externalFile, linkedFile, "file");
    assert.throws(
      () => new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file: linkedFile }),
      /must not contain symbolic links/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skill lifecycle rejects a symlink ancestor even when the immediate parent is a real directory", () => {
  const root = dir();
  try {
    const realDirectory = path.join(root, "real");
    const nestedDirectory = path.join(realDirectory, "nested");
    const linkedDirectory = path.join(root, "linked");
    mkdirSync(nestedDirectory, { recursive: true });
    symlinkSync(realDirectory, linkedDirectory, "dir");

    assert.throws(
      () => new VersionedSkillLifecycle(
        new InMemorySkillsPlatform(),
        passing,
        { file: path.join(linkedDirectory, "nested", "lifecycle.json") },
      ),
      /must not contain symbolic links/,
    );
    assert.equal(existsSync(path.join(nestedDirectory, "lifecycle.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skill lifecycle rechecks parent path before writing after construction", () => {
  const root = dir();
  try {
    const realDirectory = path.join(root, "real");
    const linkedDirectory = path.join(root, "late-link");
    const lifecycle = new VersionedSkillLifecycle(
      new InMemorySkillsPlatform(),
      passing,
      { file: path.join(linkedDirectory, "lifecycle.json") },
    );
    mkdirSync(realDirectory);
    symlinkSync(realDirectory, linkedDirectory, "dir");

    assert.throws(
      () => lifecycle.propose(pkg("1.0.0"), {
        source: "repair",
        evidenceIds: ["symlink-parent-write"],
        confidence: 0.95,
      }),
      /must not contain symbolic links/,
    );
    assert.equal(existsSync(path.join(realDirectory, "lifecycle.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("skill lifecycle rejects duplicate persisted record identities and invalid provenance", () => {
  const root = dir();
  try {
    const baseRecord = {
      id: "duplicate-record",
      skillId: "repair-skill",
      package: pkg("1.0.0"),
      status: "candidate",
      provenance: { source: "repair", evidenceIds: ["evidence-1"], confidence: 0.9 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const cases = [
      {
        name: "duplicate record ids",
        records: [baseRecord, { ...baseRecord, skillId: "another-skill", package: { ...pkg("1.0.0"), skill: { ...pkg("1.0.0").skill, id: "another-skill" } } }],
      },
      {
        name: "blank evidence ids",
        records: [{ ...baseRecord, provenance: { ...baseRecord.provenance, evidenceIds: ["  "] } }],
      },
      {
        name: "duplicate evidence ids",
        records: [{ ...baseRecord, provenance: { ...baseRecord.provenance, evidenceIds: ["same", "same"] } }],
      },
      {
        name: "invalid skill ids",
        records: [{ ...baseRecord, skillId: "__proto__" }],
      },
      {
        name: "invalid timestamps",
        records: [{ ...baseRecord, createdAt: "not-a-date" }],
      },
    ];

    for (const [index, item] of cases.entries()) {
      const file = path.join(root, `invalid-${index}.json`);
      writeFileSync(file, JSON.stringify({ schemaVersion: 1, records: item.records, activeBySkill: {} }));
      assert.throws(
        () => new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file }),
        /Invalid skill lifecycle record/,
        item.name,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
