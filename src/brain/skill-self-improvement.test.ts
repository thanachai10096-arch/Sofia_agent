import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillSelfImprovementLoop, type SkillImprovementEvidence, type SkillImprovementProposal } from "./skill-self-improvement.js";
import { VersionedSkillLifecycle, getSkillCandidateDigest } from "./skill-lifecycle.js";
import { InMemorySkillsPlatform, type SkillPackage } from "../skills/platform.js";

function makePackage(version = "1.0.0"): SkillPackage {
  return { source: "learned", version, skill: {
    id: "repair-skill", name: "Repair skill", description: "Candidate generated from verified evidence",
    triggers: ["test failure"], categories: ["runtime_error"], strategy: "inspect-evidence",
    procedure: ["inspect trusted evidence", "verify with tests"], verification: ["test"],
  } };
}
const evidence: SkillImprovementEvidence[] = [
  { id: "run-101", skillId: "repair-skill", category: "runtime_error", summary: "A verified regression was repaired", verified: true },
  { id: "run-102", skillId: "repair-skill", category: "runtime_error", summary: "A second verified regression was repaired", verified: true },
  { id: "unverified", skillId: "repair-skill", category: "runtime_error", summary: "Unverified report", verified: false },
];
function setup(options: { approve?: boolean; maxProposals?: number } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-self-improve-"));
  const platform = new InMemorySkillsPlatform();
  const lifecycle = new VersionedSkillLifecycle(platform, async (candidate) => ({
    passed: true,
    checks: [{ name: "policy", passed: true }, { name: "regression", passed: true }],
    runtimeVerification: {
      candidateDigest: getSkillCandidateDigest(candidate), runnerId: "isolated-test-runner",
      isolatedWorkspaceId: "isolated-workspace", isolated: true,
      executedChecks: candidate.skill.verification.map((name) => ({ name, passed: true })),
      completedAt: new Date().toISOString(),
    },
  }), { file: path.join(directory, "lifecycle.json") });
  const proposal: SkillImprovementProposal = {
    skillPackage: makePackage(),
    provenance: { source: "planner", evidenceIds: ["run-101", "run-102"], confidence: 0.95 },
  };
  const loop = new SkillSelfImprovementLoop(lifecycle, {
    propose: async () => [proposal],
  }, {
    ...(options.maxProposals ? { maxProposalsPerRun: options.maxProposals } : {}),
    ...(options.approve !== undefined ? { approvePromotion: async () => options.approve! } : {}),
  });
  return { directory, platform, lifecycle, loop, proposal };
}

test("self-improvement requires verified evidence and never calls planner for unverified-only input", async () => {
  const f = setup();
  let calls = 0;
  const loop = new SkillSelfImprovementLoop(f.lifecycle, { propose: async () => { calls++; return []; } });
  try {
    const report = await loop.run([evidence[2]!]);
    assert.equal(calls, 0);
    assert.equal(report.proposalCount, 0);
    assert.equal(report.promoted, 0);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("self-improvement evaluates candidate but requires explicit approval before promotion", async () => {
  const f = setup();
  try {
    const report = await f.loop.run(evidence);
    assert.equal(report.consideredEvidence, 3);
    assert.equal(report.proposalCount, 1);
    assert.equal(report.promoted, 0);
    assert.equal(report.items[0]?.outcome, "approval_declined");
    assert.equal(f.lifecycle.list("repair-skill")[0]?.status, "verified");
    assert.equal(f.platform.get("repair-skill"), undefined);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("self-improvement promotes only after approval and isolated evaluation succeed", async () => {
  const f = setup({ approve: true });
  try {
    const report = await f.loop.run(evidence);
    assert.equal(report.promoted, 1);
    assert.equal(report.items[0]?.outcome, "promoted");
    assert.equal(f.platform.get("repair-skill")?.version, "1.0.0");
    assert.equal(f.lifecycle.active("repair-skill")?.status, "active");
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("self-improvement is idempotent for the same candidate and evidence set", async () => {
  const f = setup();
  try {
    const first = await f.loop.run(evidence);
    const second = await f.loop.run(evidence);
    assert.equal(first.items[0]?.outcome, "approval_declined");
    assert.equal(second.items[0]?.outcome, "duplicate");
    assert.equal(f.lifecycle.list("repair-skill").length, 1);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("self-improvement rejects proposals not grounded in matching verified skill evidence", async () => {
  const f = setup();
  try {
    const loop = new SkillSelfImprovementLoop(f.lifecycle, {
      propose: async () => [{
        skillPackage: { ...makePackage(), skill: { ...makePackage().skill, id: "other-skill" } },
        provenance: { source: "planner", evidenceIds: ["run-101", "run-102"], confidence: 0.99 },
      }],
    }, { approvePromotion: async () => true });
    const report = await loop.run(evidence);
    assert.equal(report.items[0]?.outcome, "invalid");
    assert.equal(f.platform.get("other-skill"), undefined);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("self-improvement bounds evidence and proposal processing", async () => {
  const f = setup({ maxProposals: 1 });
  try {
    await assert.rejects(() => f.loop.run(Array.from({ length: 65 }, (_, index) => ({
      id: `e-${index}`, skillId: "repair-skill", category: "runtime_error",
      summary: "verified evidence", verified: true,
    }))), /at most 64/);
    const report = await f.loop.run(evidence);
    assert.equal(report.proposalCount, 1);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("self-improvement rejects duplicate and malformed evidence identifiers", async () => {
  const f = setup();
  try {
    await assert.rejects(() => f.loop.run([evidence[0]!, evidence[0]!]), /Duplicate skill improvement evidence id/);
    await assert.rejects(() => f.loop.run([{ ...evidence[0]!, summary: " " }]), /Invalid skill improvement evidence/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
