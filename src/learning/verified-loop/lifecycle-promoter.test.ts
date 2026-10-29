import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VersionedSkillLifecycle } from "../../brain/skill-lifecycle.js";
import { InMemorySkillsPlatform } from "../../skills/platform.js";
import { createLearningLifecyclePromoter } from "./lifecycle-promoter.js";
import type { LearningScope, SkillCandidate } from "./ports.js";

const scope: LearningScope = { tenantId: "tenant", principalId: "principal", projectId: "project" };
const candidate: SkillCandidate = {
  id: "learned:0123456789abcdef",
  scope,
  experienceId: "experience-1",
  name: "learned-0123456789ab",
  trigger: "Fix TypeScript build",
  procedure: ["Inspect trusted evidence", "Run verification checks"],
  confidence: 0.9,
};

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-learning-lifecycle-"));
  const platform = new InMemorySkillsPlatform();
  const lifecycle = new VersionedSkillLifecycle(platform, async () => ({
    passed: true,
    checks: [{ name: "policy-and-regression", passed: true }],
  }), { file: path.join(directory, "lifecycle.json") });
  return { directory, platform, lifecycle };
}

test("lifecycle promoter requires explicit approval before platform activation", async () => {
  const f = fixture();
  try {
    const promoter = createLearningLifecyclePromoter({
      lifecycle: f.lifecycle,
      approval: async request => {
        assert.equal(request.toolName, "skill.lifecycle.promote");
        assert.equal(request.risk, "high");
        return false;
      },
      resolveEvidenceIds: async () => ["trusted-evidence-1"],
      resolveRunId: () => "run-1",
    });
    assert.equal(await promoter(scope, candidate), false);
    assert.equal(f.platform.get(candidate.id), undefined);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("lifecycle promoter activates only through the existing evaluated-and-approved workflow", async () => {
  const f = fixture();
  try {
    const promoter = createLearningLifecyclePromoter({
      lifecycle: f.lifecycle,
      approval: async request => Boolean(request.actionHash && request.principalId === scope.principalId),
      resolveEvidenceIds: async (_scope, experienceId) => experienceId === candidate.experienceId ? ["trusted-evidence-1"] : [],
      resolveRunId: () => "run-2",
    });
    assert.equal(await promoter(scope, candidate), true);
    assert.equal(f.platform.get(candidate.id)?.source, "learned");
    assert.equal(f.lifecycle.active(candidate.id)?.status, "active");
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("lifecycle promoter fails closed when approval or trusted evidence is unavailable", async () => {
  const f = fixture();
  try {
    const noApproval = createLearningLifecyclePromoter({
      lifecycle: f.lifecycle,
      resolveEvidenceIds: async () => ["trusted-evidence-1"],
      resolveRunId: () => "run-3",
    });
    assert.equal(await noApproval(scope, candidate), false);
    const noEvidence = createLearningLifecyclePromoter({
      lifecycle: f.lifecycle,
      approval: async () => true,
      resolveEvidenceIds: async () => [],
      resolveRunId: () => "run-3",
    });
    assert.equal(await noEvidence(scope, candidate), false);
    assert.equal(f.platform.get(candidate.id), undefined);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});


test("lifecycle promoter rejects cross-scope and malformed candidates before resolving evidence", async () => {
  const f = fixture();
  try {
    let evidenceLookups = 0;
    const promoter = createLearningLifecyclePromoter({
      lifecycle: f.lifecycle,
      approval: async () => { assert.fail("invalid candidate must never reach approval"); },
      resolveEvidenceIds: async () => { evidenceLookups++; return ["trusted-evidence-1"]; },
      resolveRunId: () => "run-invalid",
    });
    assert.equal(await promoter({ ...scope, tenantId: "other-tenant" }, candidate), false);
    assert.equal(await promoter(scope, { ...candidate, confidence: Number.NaN }), false);
    assert.equal(await promoter(scope, { ...candidate, procedure: [] }), false);
    assert.equal(await promoter(scope, { ...candidate, trigger: " ".repeat(3) }), false);
    assert.equal(evidenceLookups, 0);
    assert.equal(f.platform.get(candidate.id), undefined);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
