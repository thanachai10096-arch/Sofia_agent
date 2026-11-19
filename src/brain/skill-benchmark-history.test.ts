import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileSkillBenchmarkHistory } from "./skill-benchmark-history.js";

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-skill-benchmark-"));
  return {
    directory,
    file: path.join(directory, ".sofia", "skill-benchmark-history.json"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    skillId: "learned:repair",
    skillVersion: "1.0.0",
    evaluatedAt: new Date(0).toISOString(),
    passed: true,
    checks: [{ name: "typecheck", passed: true }, { name: "test", passed: true }],
    ...overrides,
  };
}

test("benchmark history persists records across store instances and preserves append order", () => {
  const f = fixture();
  try {
    const first = new FileSkillBenchmarkHistory(f.file);
    const saved = first.append(record());
    const second = new FileSkillBenchmarkHistory(f.file);
    second.append(record({ skillVersion: "1.0.1", baselineVersion: "1.0.0" }));
    assert.equal(second.list("learned:repair").length, 2);
    assert.equal(second.latest("learned:repair")?.skillVersion, "1.0.1");
    assert.equal(second.list()[0]?.id, saved.id);
  } finally { f.cleanup(); }
});

test("benchmark history treats an identical record ID as idempotent and rejects conflicting reuse", () => {
  const f = fixture();
  try {
    const history = new FileSkillBenchmarkHistory(f.file);
    const saved = history.append(record({ id: "00000000-0000-4000-8000-000000000001" }));
    assert.equal(history.append({ ...record(), id: saved.id }).id, saved.id);
    assert.throws(() => history.append({ ...record({ skillVersion: "2.0.0" }), id: saved.id }), /different content/);
    assert.equal(history.list().length, 1);
  } finally { f.cleanup(); }
});

test("benchmark history rejects malformed and duplicate check identities", () => {
  const f = fixture();
  try {
    const history = new FileSkillBenchmarkHistory(f.file);
    assert.throws(() => history.append(record({ checks: [] })), /Invalid skill benchmark history record/);
    assert.throws(() => history.append(record({ checks: [
      { name: "test", passed: true }, { name: " test ", passed: true },
    ] })), /Invalid skill benchmark history record/);
    assert.equal(history.list().length, 0);
  } finally { f.cleanup(); }
});

test("benchmark history refuses to overwrite corrupt persisted data", () => {
  const f = fixture();
  try {
    mkdirSync(path.dirname(f.file), { recursive: true });
    writeFileSync(f.file, "{not-json", "utf8");
    const history = new FileSkillBenchmarkHistory(f.file);
    assert.throws(() => history.append(record()), /corrupt/);
    assert.equal(readFileSync(f.file, "utf8"), "{not-json");
  } finally { f.cleanup(); }
});

test("benchmark history rejects symbolic-link stores and never follows them", () => {
  const f = fixture();
  try {
    mkdirSync(path.dirname(f.file), { recursive: true });
    const target = path.join(f.directory, "target.json");
    writeFileSync(target, JSON.stringify({ schemaVersion: 1, records: [] }), "utf8");
    symlinkSync(target, f.file);
    const history = new FileSkillBenchmarkHistory(f.file);
    assert.throws(() => history.append(record()), /symbolic link/);
    assert.equal(JSON.parse(readFileSync(target, "utf8")).records.length, 0);
  } finally { f.cleanup(); }
});

test("benchmark history fails closed when a writer lock already exists", () => {
  const f = fixture();
  try {
    mkdirSync(path.dirname(f.file), { recursive: true });
    writeFileSync(f.file + ".lock", "operator-owned lock", "utf8");
    const history = new FileSkillBenchmarkHistory(f.file);
    assert.throws(() => history.append(record()), /EEXIST/);
    assert.equal(history.list().length, 0);
  } finally { f.cleanup(); }
});
