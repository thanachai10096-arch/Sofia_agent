import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileSkillLedger } from "../src/brain/file-skill-ledger.js";
import type { LearnedSkillCandidate } from "../src/brain/learning.js";

const candidate: LearnedSkillCandidate = {
  name: "repair-runtime_error",
  trigger: "test failed",
  category: "runtime_error",
  strategy: "inspect-evidence",
  procedure: ["inspect trusted failure evidence", "run the trusted verification"],
  verification: ["test"],
  evidenceIds: ["run-123"],
};

test("file skill ledger persists entries and reloads them", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sofia-file-skill-ledger-"));
  const file = path.join(root, "state", "ledger.json");
  try {
    const ledger = new FileSkillLedger(file);
    ledger.record(candidate);
    const restored = new FileSkillLedger(file);
    assert.deepEqual(restored.list(), [candidate]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("file skill ledger deduplicates equivalent candidates and returns defensive copies", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sofia-file-skill-ledger-"));
  try {
    const ledger = new FileSkillLedger(path.join(root, "ledger.json"));
    ledger.record(candidate);
    ledger.record({ ...candidate, evidenceIds: ["different-evidence"] });
    assert.equal(ledger.list().length, 1);
    const listed = ledger.list() as LearnedSkillCandidate[];
    listed[0]!.procedure.push("caller mutation");
    assert.equal(ledger.list()[0]!.procedure.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("file skill ledger rejects malformed and unbounded candidates without persisting them", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sofia-file-skill-ledger-"));
  const file = path.join(root, "ledger.json");
  try {
    const ledger = new FileSkillLedger(file);
    assert.throws(() => ledger.record({ ...candidate, evidenceIds: [] }), /Invalid learned skill candidate/);
    assert.throws(() => ledger.record({ ...candidate, procedure: Array.from({ length: 101 }, () => "step") }), /Invalid learned skill candidate/);
    assert.equal(ledger.list().length, 0);
    assert.equal(existsSync(file), false, "invalid candidates must not create persisted state");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("file skill ledger refuses symbolic-link stores", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sofia-file-skill-ledger-"));
  try {
    const target = path.join(root, "target.json");
    const link = path.join(root, "ledger.json");
    writeFileSync(target, JSON.stringify({ schemaVersion: 1, entries: [] }));
    symlinkSync(target, link);
    assert.throws(() => new FileSkillLedger(link), /must not be a symbolic link/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("file skill ledger redacts secret-like trigger text before persistence", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sofia-file-skill-ledger-"));
  const file = path.join(root, "ledger.json");
  try {
    const ledger = new FileSkillLedger(file);
    ledger.record({ ...candidate, trigger: "api_key=super-secret-value" });
    const raw = readFileSync(file, "utf8");
    assert.equal(raw.includes("super-secret-value"), false);
    assert.equal(ledger.list()[0]!.trigger.includes("super-secret-value"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
