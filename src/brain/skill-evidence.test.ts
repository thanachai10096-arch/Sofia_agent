import test from "node:test";
import assert from "node:assert/strict";
import type { SecurityAuditEvent } from "../security/audit.js";
import type { SkillPackage } from "../skills/platform.js";
import { AuditSkillEvidenceVerifier } from "./skill-evidence.js";

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
