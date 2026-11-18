import test from "node:test";
import assert from "node:assert/strict";
import type { SecurityAuditEvent } from "../security/audit.js";
import type { SkillPackage } from "../skills/platform.js";
import { AuditSkillEvidenceVerifier, skillPackageDigest } from "./skill-evidence.js";

const runId = "brain-run-1";
const skill: SkillPackage = {
  source: "learned",
  version: "1.0.0",
  skill: {
    id: "learned:repair",
    name: "Repair",
    description: "Verified repair workflow",
    triggers: ["type error"],
    categories: ["type_error"],
    strategy: "fix-implementation",
    procedure: ["inspect", "repair", "verify"],
    verification: ["typecheck", "test", "build"],
  },
};
function event(kind: string, overrides: Partial<SecurityAuditEvent> = {}): SecurityAuditEvent {
  return {
    id: "evidence-" + kind,
    at: new Date(0).toISOString(),
    runId,
    toolName: "project.verify",
    actionHash: "action-hash",
    risk: "low",
    decision: "completed",
    input: { kind },
    result: { kind, code: 0, passed: true },
    ...overrides,
  };
}
const provenance = {
  source: "verified-brain-repair",
  runId,
  evidenceIds: ["evidence-typecheck", "evidence-test", "evidence-build"],
  confidence: 0.8,
  skillDigest: skillPackageDigest(skill),
};

test("trusted evidence verifier accepts successful audit records from the same Brain run", async () => {
  const records = ["typecheck", "test", "build"].map((kind) => event(kind));
  const verifier = new AuditSkillEvidenceVerifier(async () => records);
  const checks = await verifier.verify(skill, provenance);
  assert.equal(checks.every((check) => check.passed), true);
});

test("trusted evidence verifier rejects forged, failed, and cross-run evidence", async () => {
  const records = [
    event("typecheck"),
    event("test", { runId: "different-run" }),
    event("build", { result: { kind: "build", code: 1, passed: false } }),
  ];
  const verifier = new AuditSkillEvidenceVerifier(async () => records);
  const checks = await verifier.verify(skill, provenance);
  assert.equal(checks.every((check) => check.passed), false);
  assert.equal(checks.find((check) => check.name === "required-verification:test")?.passed, false);
  assert.equal(checks.find((check) => check.name === "required-verification:build")?.passed, false);
});

test("trusted evidence verifier fails closed when audit evidence is unavailable", async () => {
  const verifier = new AuditSkillEvidenceVerifier(async () => { throw new Error("audit unavailable"); });
  const checks = await verifier.verify(skill, provenance);
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.passed, false);
});

test("trusted evidence verifier requires run-bound provenance and all verification kinds", async () => {
  const verifier = new AuditSkillEvidenceVerifier(async () => []);
  const missingRun = await verifier.verify(skill, { ...provenance, runId: undefined });
  assert.equal(missingRun.every((check) => !check.passed), true);
  const missingEvidence = await verifier.verify(skill, { ...provenance, evidenceIds: ["evidence-typecheck"] });
  assert.equal(missingEvidence[0]?.passed, false);
});


test("trusted evidence verifier rejects a result whose verification kind differs from its request", async () => {
  const records = [
    event("typecheck"),
    event("test"),
    event("build", { result: { kind: "test", code: 0, passed: true } }),
  ];
  const verifier = new AuditSkillEvidenceVerifier(async () => records);
  const checks = await verifier.verify(skill, provenance);
  assert.equal(checks.find((check) => check.name === "evidence:evidence-build")?.passed, false);
  assert.equal(checks.find((check) => check.name === "required-verification:build")?.passed, false);
});


test("trusted evidence verifier rejects conflicting audit records that reuse an evidence ID", async () => {
  const records = [
    event("typecheck"),
    event("test"),
    event("build"),
    event("typecheck", { result: { kind: "typecheck", code: 1, passed: false } }),
  ];
  const verifier = new AuditSkillEvidenceVerifier(async () => records);
  const checks = await verifier.verify(skill, provenance);
  assert.equal(checks.find((check) => check.name === "evidence:evidence-typecheck")?.passed, false);
  assert.equal(checks.find((check) => check.name === "required-verification:typecheck")?.passed, false);
});

test("trusted evidence verifier rejects surplus evidence IDs instead of silently ignoring them", async () => {
  const verifier = new AuditSkillEvidenceVerifier(async () => ["typecheck", "test", "build"].map((kind) => event(kind)));
  const checks = await verifier.verify(skill, {
    ...provenance,
    evidenceIds: [...provenance.evidenceIds, "unused-extra-evidence"],
  });
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.name, "trusted-evidence-count");
  assert.equal(checks[0]?.passed, false);
});


test("trusted evidence verifier rejects a changed Skill artifact digest", async () => {
  const records = ["typecheck", "test", "build"].map((kind) => event(kind));
  const verifier = new AuditSkillEvidenceVerifier(async () => records);
  const changedSkill: SkillPackage = {
    ...skill,
    skill: { ...skill.skill, procedure: [...skill.skill.procedure, "unverified extra step"] },
  };
  const checks = await verifier.verify(changedSkill, provenance);
  assert.equal(checks[0]?.name, "skill-artifact-digest");
  assert.equal(checks[0]?.passed, false);
});

test("skill package digest is stable for object key order and changes with artifact content", () => {
  const reordered = {
    version: skill.version,
    skill: skill.skill,
    source: skill.source,
  } as SkillPackage;
  assert.equal(skillPackageDigest(reordered), skillPackageDigest(skill));
  assert.notEqual(
    skillPackageDigest({ ...skill, version: "1.0.1" }),
    skillPackageDigest(skill),
  );
});
