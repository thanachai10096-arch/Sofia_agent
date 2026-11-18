import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("stale lifecycle instance cannot mutate the platform after a newer promotion", async () => {
  const root = dir();
  try {
    const file = path.join(root, "shared-platform.json");
    const platform = new InMemorySkillsPlatform();
    const seed = new VersionedSkillLifecycle(platform, passing, { file });
    const first = seed.propose({ ...pkg("1.0.0"), source: "custom" }, {
      source: "first", evidenceIds: ["first-evidence"], confidence: 0.95,
    });
    await seed.evaluate(first.id);
    const second = seed.propose({ ...pkg("2.0.0"), source: "custom" }, {
      source: "second", evidenceIds: ["second-evidence"], confidence: 0.95,
    });
    await seed.evaluate(second.id);

    const stale = new VersionedSkillLifecycle(platform, passing, { file });
    seed.promote(first.id);
    assert.equal(platform.get("repair-skill")?.version, "1.0.0");

    assert.throws(
      () => stale.promote(second.id),
      /Skill lifecycle store changed in another process; reload before platform mutation/,
    );
    assert.equal(platform.get("repair-skill")?.version, "1.0.0", "stale promotion must not alter the shared platform");
    assert.equal(existsSync(file + ".mutation.lock"), false, "mutation lock must be released after stale revision rejection");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stale lifecycle instance cannot append a candidate after another writer commits", () => {
  const root = dir();
  try {
    const file = path.join(root, "stale-proposal.json");
    const first = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file });
    const stale = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file });
    first.propose({ ...pkg("1.0.0"), source: "custom" }, {
      source: "first-writer", evidenceIds: ["first"], confidence: 0.9,
    });
    assert.throws(
      () => stale.propose({ ...pkg("2.0.0"), source: "custom" }, {
        source: "stale-writer", evidenceIds: ["stale"], confidence: 0.9,
      }),
      /Skill lifecycle store changed in another process; reload before platform mutation/,
    );
    assert.equal(stale.list().length, 0);
    assert.equal(existsSync(file + ".mutation.lock"), false);
    assert.equal(new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file }).list().length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stale lifecycle evaluation cannot overwrite a concurrent promotion", async () => {
  const root = dir();
  try {
    const file = path.join(root, "stale-evaluation.json");
    const platform = new InMemorySkillsPlatform();
    const first = new VersionedSkillLifecycle(platform, passing, { file });
    const candidate = first.propose({ ...pkg("1.0.0"), source: "custom" }, {
      source: "first-writer", evidenceIds: ["evaluation-evidence"], confidence: 0.9,
    });
    const stale = new VersionedSkillLifecycle(platform, passing, { file });
    await first.evaluate(candidate.id);
    first.promote(candidate.id);
    await assert.rejects(
      () => stale.evaluate(candidate.id),
      /Skill lifecycle store changed in another process; reload before platform mutation/,
    );
    assert.equal(platform.get("repair-skill")?.version, "1.0.0");
    assert.equal(existsSync(file + ".mutation.lock"), false);
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


test("failed rollback removes a partially installed previous skill when the platform had no current entry", async () => {
  const root = dir();
  try {
    const file = path.join(root, "rollback-compensation.json");
    const platform = new InMemorySkillsPlatform();
    const lifecycle = new VersionedSkillLifecycle(platform, passing, { file });
    const first = lifecycle.propose({ ...pkg("1.0.0"), source: "custom" }, {
      source: "first", evidenceIds: ["rollback-first"], confidence: 0.95,
    });
    await lifecycle.evaluate(first.id);
    lifecycle.promote(first.id);
    const second = lifecycle.propose({ ...pkg("2.0.0"), source: "custom" }, {
      source: "second", evidenceIds: ["rollback-second"], confidence: 0.95,
    });
    await lifecycle.evaluate(second.id);
    lifecycle.promote(second.id);

    platform.remove("repair-skill");
    writeFileSync(file + ".lock", "held", { flag: "wx", mode: 0o600 });
    assert.throws(() => lifecycle.rollback("repair-skill"), /EEXIST/);
    assert.equal(platform.get("repair-skill"), undefined, "failed rollback must undo its partial install");
    assert.equal(lifecycle.active("repair-skill")?.id, second.id, "durable lifecycle state must remain on the active version");
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


test("separate lifecycle instances fail closed instead of overwriting a newer snapshot", () => {
  const root = dir();
  try {
    const file = path.join(root, "shared-lifecycle.json");
    const first = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file });
    const stale = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file });

    const committed = first.propose(pkg("1.0.0"), {
      source: "first-writer", evidenceIds: ["writer-one"], confidence: 0.9,
    });
    assert.equal(committed.status, "candidate");

    assert.throws(
      () => stale.propose({ ...pkg("2.0.0"), source: "custom" }, {
        source: "stale-writer", evidenceIds: ["writer-two"], confidence: 0.9,
      }),
      /Skill lifecycle store changed in another process; reload before writing/,
    );
    assert.equal(stale.list().length, 0, "failed stale write must roll back its in-memory mutation");

    const reloaded = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file });
    assert.deepEqual(reloaded.list().map((record) => record.id), [committed.id]);
    assert.equal(reloaded.list()[0]?.package.version, "1.0.0");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill lifecycle refuses a second writer while the cross-process lock is held", () => {
  const root = dir();
  try {
    const file = path.join(root, "locked-lifecycle.json");
    const lifecycle = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file });
    writeFileSync(file + ".lock", "held", { flag: "wx", mode: 0o600 });
    assert.throws(
      () => lifecycle.propose(pkg("1.0.0"), {
        source: "locked-writer", evidenceIds: ["lock-evidence"], confidence: 0.9,
      }),
      /EEXIST/,
    );
    assert.equal(lifecycle.list().length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("lifecycle instances loaded from the same existing revision cannot lose a later update", () => {
  const root = dir();
  try {
    const file = path.join(root, "existing-revision.json");
    const seed = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file });
    seed.propose({ ...pkg("0.9.0"), source: "custom" }, {
      source: "seed", evidenceIds: ["seed-evidence"], confidence: 0.9,
    });

    const writerA = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file });
    const writerB = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file });
    writerA.propose({ ...pkg("1.0.0"), source: "custom" }, {
      source: "writer-a", evidenceIds: ["writer-a-evidence"], confidence: 0.9,
    });

    assert.throws(
      () => writerB.propose({ ...pkg("2.0.0"), source: "custom" }, {
        source: "writer-b", evidenceIds: ["writer-b-evidence"], confidence: 0.9,
      }),
      /Skill lifecycle store changed in another process; reload before writing/,
    );
    assert.equal(existsSync(file + ".lock"), false, "compare-and-swap conflict must release its lock");
    const reloaded = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file });
    assert.deepEqual(reloaded.list().map((record) => record.package.version), ["0.9.0", "1.0.0"]);
    reloaded.propose({ ...pkg("2.0.0"), source: "custom" }, {
      source: "writer-c-after-reload", evidenceIds: ["writer-c-evidence"], confidence: 0.9,
    });
    assert.equal(new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file }).list().length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("corrupt skill lifecycle JSON fails closed without rewriting the damaged store", () => {
  const root = dir();
  try {
    const file = path.join(root, "corrupt-lifecycle.json");
    const damaged = '{"schemaVersion":1,"records":[';
    writeFileSync(file, damaged, { mode: 0o600 });
    assert.throws(
      () => new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file }),
      /Unsupported or corrupt skill lifecycle store/,
    );
    assert.equal(readFileSync(file, "utf8"), damaged, "startup must preserve damaged bytes for recovery");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("startup restoration compensates earlier registrations when a later registration fails", async () => {
  const root = dir();
  try {
    const file = path.join(root, "partial-startup-restore.json");
    const seedPlatform = new InMemorySkillsPlatform();
    const seed = new VersionedSkillLifecycle(seedPlatform, passing, { file });
    const first = seed.propose({ ...pkg("1.0.0"), source: "custom" }, {
      source: "startup-first", evidenceIds: ["startup-first"], confidence: 0.95,
    });
    await seed.evaluate(first.id);
    seed.promote(first.id);
    const secondPackage = {
      ...pkg("2.0.0"),
      source: "custom" as const,
      skill: { ...pkg("2.0.0").skill, id: "second-skill", name: "Second skill" },
    };
    const second = seed.propose(secondPackage, {
      source: "startup-second", evidenceIds: ["startup-second"], confidence: 0.95,
    });
    await seed.evaluate(second.id);
    seed.promote(second.id);

    const restoredPlatform = new InMemorySkillsPlatform();
    let registrations = 0;
    const failingPlatform = {
      get: (id: string) => restoredPlatform.get(id),
      list: (source?: "builtin" | "learned" | "project" | "custom" | "marketplace") => restoredPlatform.list(source),
      remove: (id: string) => restoredPlatform.remove(id),
      register: (skill: SkillPackage) => {
        registrations += 1;
        if (registrations === 2) throw new Error("simulated second registration failure");
        restoredPlatform.register(skill);
      },
    };
    assert.throws(
      () => new VersionedSkillLifecycle(failingPlatform, passing, { file }),
      /simulated second registration failure/,
    );
    assert.equal(restoredPlatform.get("repair-skill"), undefined, "first registration must be compensated");
    assert.equal(restoredPlatform.get("second-skill"), undefined, "failed registration must not leave a partial restore");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("startup restoration refuses to mutate the platform while another lifecycle process holds the mutation lock", async () => {
  const root = dir();
  try {
    const file = path.join(root, "startup-mutation-lock.json");
    const seedPlatform = new InMemorySkillsPlatform();
    const seed = new VersionedSkillLifecycle(seedPlatform, passing, { file });
    const candidate = seed.propose({ ...pkg("1.0.0"), source: "custom" }, {
      source: "startup", evidenceIds: ["startup-restore"], confidence: 0.95,
    });
    await seed.evaluate(candidate.id);
    seed.promote(candidate.id);

    const targetPlatform = new InMemorySkillsPlatform();
    writeFileSync(file + ".mutation.lock", "held", { flag: "wx", mode: 0o600 });
    assert.throws(
      () => new VersionedSkillLifecycle(targetPlatform, passing, { file }),
      /EEXIST/,
    );
    assert.equal(targetPlatform.get("repair-skill"), undefined, "startup must not restore skills without the cross-process lock");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("startup quarantine fails closed when another process holds the lifecycle lock", async () => {
  const root = dir();
  try {
    const file = path.join(root, "startup-quarantine.json");
    const first = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file });
    const learned = first.propose(pkg("1.0.0"), {
      source: "verified-brain-repair",
      evidenceIds: ["startup-evidence"],
      confidence: 0.95,
      runId: "startup-run",
      skillDigest: "c".repeat(64),
    });
    await first.evaluate(learned.id);
    first.promote(learned.id);
    const before = readFileSync(file, "utf8");

    writeFileSync(file + ".lock", "held", { flag: "wx", mode: 0o600 });
    assert.throws(
      () => new VersionedSkillLifecycle(new InMemorySkillsPlatform(), passing, { file }),
      /EEXIST/,
    );
    assert.equal(readFileSync(file, "utf8"), before, "failed startup quarantine must not partially rewrite the store");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("startup restore reports incomplete compensation instead of hiding platform inconsistency", async () => {
  const root = dir();
  try {
    const file = path.join(root, "partial-startup-compensation-failure.json");
    const seedPlatform = new InMemorySkillsPlatform();
    const seed = new VersionedSkillLifecycle(seedPlatform, passing, { file });
    const first = seed.propose({ ...pkg("1.0.0"), source: "custom" }, {
      source: "startup-first", evidenceIds: ["startup-first"], confidence: 0.95,
    });
    await seed.evaluate(first.id);
    seed.promote(first.id);
    const secondPackage = {
      ...pkg("2.0.0"),
      source: "custom" as const,
      skill: { ...pkg("2.0.0").skill, id: "second-skill", name: "Second skill" },
    };
    const second = seed.propose(secondPackage, {
      source: "startup-second", evidenceIds: ["startup-second"], confidence: 0.95,
    });
    await seed.evaluate(second.id);
    seed.promote(second.id);

    const target = new InMemorySkillsPlatform();
    let registrations = 0;
    const brokenPlatform = {
      get: (id: string) => target.get(id),
      list: (source?: "builtin" | "learned" | "project" | "custom" | "marketplace") => target.list(source),
      register: (skill: SkillPackage) => {
        registrations += 1;
        if (registrations === 2) throw new Error("restore registration failed");
        target.register(skill);
      },
      remove: (_id: string) => { throw new Error("compensation removal failed"); },
    };

    assert.throws(
      () => new VersionedSkillLifecycle(brokenPlatform, passing, { file }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /compensation was incomplete/);
        assert.equal(error.errors.length, 2);
        assert.match(String(error.errors[0]), /restore registration failed/);
        assert.match(String(error.errors[1]), /compensation removal failed/);
        return true;
      },
    );
    assert.equal(target.get("repair-skill")?.version, "1.0.0", "test documents the partial platform state requiring reconciliation");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("promotion reports both the original and compensation errors", async () => {
  const root = dir();
  try {
    const file = path.join(root, "promotion-compensation.json");
    const backing = new InMemorySkillsPlatform();
    const seed = new VersionedSkillLifecycle(backing, passing, { file });
    const first = seed.propose({ ...pkg("1.0.0"), source: "custom" }, {
      source: "first", evidenceIds: ["first"], confidence: 0.95,
    });
    await seed.evaluate(first.id);
    seed.promote(first.id);

    let failMutations = false;
    const platform = {
      get: (id: string) => backing.get(id),
      list: (source?: "builtin" | "learned" | "project" | "custom" | "marketplace") => backing.list(source),
      remove: (id: string) => backing.remove(id),
      register: (skill: SkillPackage) => {
        if (failMutations && skill.version === "2.0.0") throw new Error("promotion register failed");
        if (failMutations && skill.version === "1.0.0") throw new Error("promotion compensation failed");
        backing.register(skill);
      },
    };
    const lifecycle = new VersionedSkillLifecycle(platform, passing, { file });
    const next = lifecycle.propose({ ...pkg("2.0.0"), source: "custom" }, {
      source: "second", evidenceIds: ["second"], confidence: 0.95,
    });
    await lifecycle.evaluate(next.id);
    failMutations = true;

    assert.throws(() => lifecycle.promote(next.id), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /promotion failed and platform compensation was incomplete/);
      assert.equal(error.errors.length, 2);
      assert.match(String(error.errors[0]), /promotion register failed/);
      assert.match(String(error.errors[1]), /promotion compensation failed/);
      return true;
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("startup journal recovery reverts an interrupted uncommitted promotion", async () => {
  const root = dir();
  try {
    const file = path.join(root, "journal-recovery.json");
    const platform = new InMemorySkillsPlatform();
    const lifecycle = new VersionedSkillLifecycle(platform, passing, { file });
    const candidate = lifecycle.propose({ ...pkg("1.0.0"), source: "custom" }, {
      source: "journal-test", evidenceIds: ["journal-evidence"], confidence: 0.95,
    });
    await lifecycle.evaluate(candidate.id);

    // Simulate process death after the platform side effect but before the
    // lifecycle snapshot commit. The journal records the intended transition.
    platform.register({ ...candidate.package });
    writeFileSync(file + ".transaction.json", JSON.stringify({
      schemaVersion: 1,
      transactionId: "simulated-crash",
      operation: "promote",
      skillId: candidate.skillId,
      previousActiveId: null,
      targetActiveId: candidate.id,
      previousPackage: null,
      targetPackage: candidate.package,
    }));

    const recovered = new VersionedSkillLifecycle(platform, passing, { file });
    assert.equal(platform.get(candidate.skillId), undefined, "uncommitted platform side effect must be reverted");
    assert.equal(recovered.active(candidate.skillId), undefined);
    assert.equal(existsSync(file + ".transaction.json"), false, "recovered journal must be removed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("startup journal recovery preserves a committed promotion after a crash before journal cleanup", async () => {
  const root = dir();
  try {
    const file = path.join(root, "journal-committed.json");
    const platform = new InMemorySkillsPlatform();
    const lifecycle = new VersionedSkillLifecycle(platform, passing, { file });
    const candidate = lifecycle.propose({ ...pkg("1.0.0"), source: "custom" }, {
      source: "journal-committed", evidenceIds: ["journal-committed-evidence"], confidence: 0.95,
    });
    await lifecycle.evaluate(candidate.id);
    lifecycle.promote(candidate.id);

    writeFileSync(file + ".transaction.json", JSON.stringify({
      schemaVersion: 1,
      transactionId: "simulated-post-commit-crash",
      operation: "promote",
      skillId: candidate.skillId,
      previousActiveId: null,
      targetActiveId: candidate.id,
      previousPackage: null,
      targetPackage: candidate.package,
    }));
    const recovered = new VersionedSkillLifecycle(platform, passing, { file });
    assert.equal(recovered.active(candidate.skillId)?.id, candidate.id);
    assert.equal(platform.get(candidate.skillId)?.version, "1.0.0");
    assert.equal(existsSync(file + ".transaction.json"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

