import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VersionedSkillLifecycle } from "./skill-lifecycle.js";
import { InMemorySkillsPlatform } from "../skills/platform.js";
import { createManagedSkillLearningHandler } from "./managed-skill-learning.js";
import type { LearnedSkillCandidate } from "./learning.js";

const candidate: LearnedSkillCandidate = {
  name: "repair-type_error",
  trigger: "compiler reported a type mismatch",
  category: "type_error",
  strategy: "fix-implementation",
  procedure: ["inspect trusted failure evidence", "apply the repair", "verify the result"],
  verification: ["typecheck", "test", "build"],
  evidenceIds: ["verification-1"],
};

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-managed-skill-"));
  const platform = new InMemorySkillsPlatform();
  const lifecycle = new VersionedSkillLifecycle(platform, async (skill) => ({
    passed: Boolean(skill.skill.name && skill.skill.procedure.length && skill.skill.verification.length),
    checks: [{ name: "metadata-and-verification", passed: Boolean(skill.skill.name && skill.skill.procedure.length && skill.skill.verification.length) }],
  }), { file: path.join(directory, "lifecycle.json") });
  return { directory, platform, lifecycle };
}

test("managed skill learning promotes verified metadata automatically by default for an authenticated principal", async () => {
  const f = fixture();
  try {
    const handler = createManagedSkillLearningHandler(f.lifecycle);
    assert.equal(await handler(candidate, "run-auto-1", "operator-1"), true);
    assert.equal(f.platform.get("learned:repair-type_error:type_error")?.source, "learned");
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("opt-in approval mode binds promotion approval to the authenticated principal and action hash", async () => {
  const f = fixture();
  const approvalCalls: Array<{ toolName: string; risk: string; principalId?: string; actionHash: string }> = [];
  try {
    const handler = createManagedSkillLearningHandler(f.lifecycle, async (request) => {
      approvalCalls.push({ toolName: request.toolName, risk: request.risk, principalId: request.principalId, actionHash: request.actionHash });
      return true;
    }, { requireApproval: true });
    assert.equal(await handler(candidate, "run-approval-1", "operator-1"), true);
    assert.equal(approvalCalls.length, 1);
    assert.equal(approvalCalls[0]?.toolName, "skill.lifecycle.promote");
    assert.equal(approvalCalls[0]?.risk, "medium");
    assert.equal(approvalCalls[0]?.principalId, "operator-1");
    assert.ok(approvalCalls[0]?.actionHash);
    assert.equal(f.platform.get("learned:repair-type_error:type_error")?.source, "learned");
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("opt-in approval mode fails closed when approval is missing or declined", async () => {
  const f = fixture();
  try {
    const noApproval = createManagedSkillLearningHandler(f.lifecycle, undefined, { requireApproval: true });
    assert.equal(await noApproval(candidate, "run-no-approval", "operator-1"), false);
    const declined = createManagedSkillLearningHandler(f.lifecycle, async () => false, { requireApproval: true });
    assert.equal(await declined(candidate, "run-declined", "operator-1"), false);
    assert.equal(f.platform.get("learned:repair-type_error:type_error"), undefined);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("anonymous or blank-principal skill promotion never activates, even with auto-promotion enabled", async () => {
  const f = fixture();
  let approvalCalls = 0;
  try {
    const handler = createManagedSkillLearningHandler(f.lifecycle, async () => {
      approvalCalls += 1;
      return true;
    });
    assert.equal(await handler(candidate, "run-anonymous"), false);
    assert.equal(await handler(candidate, "run-blank", "   "), false);
    assert.equal(approvalCalls, 0);
    assert.equal(f.platform.get("learned:repair-type_error:type_error"), undefined);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("managed skill learning accepts verified general-workflow candidates automatically", async () => {
  const f = fixture();
  const workflowCandidate: LearnedSkillCandidate = {
    name: "workflow-general",
    trigger: "Create a reusable project summary",
    category: "unknown",
    strategy: "initial",
    procedure: ["inspect the project and constraints", "summarize verified project facts", "verify the summary against source evidence"],
    verification: ["typecheck", "test", "build"],
    evidenceIds: ["acceptance-check-1"],
  };
  try {
    const handler = createManagedSkillLearningHandler(f.lifecycle);
    assert.equal(await handler(workflowCandidate, "run-workflow-1", "operator-1"), true);
    const active = f.platform.get("learned:workflow-general:unknown");
    assert.equal(active?.source, "learned");
    assert.match(active?.skill.description ?? "", /workflow/i);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});


test("managed learning preserves real acceptance criteria and rejects candidates without evidence", async () => {
  const f = fixture();
  try {
    const handler = createManagedSkillLearningHandler(f.lifecycle);
    const acceptanceCandidate: LearnedSkillCandidate = {
      ...candidate,
      name: "workflow-acceptance-evidence",
      verification: ["acceptance:summary-matches-source"],
      evidenceIds: ["trusted-evidence-42"],
    };
    assert.equal(await handler(acceptanceCandidate, "run-acceptance", "operator-1"), true);
    const active = f.platform.get("learned:workflow-acceptance-evidence:type_error");
    assert.deepEqual(active?.skill.verification, ["acceptance:summary-matches-source"]);
    assert.deepEqual(active?.skill.triggers, [candidate.trigger]);
    assert.equal(await handler({ ...candidate, evidenceIds: [] }, "run-no-evidence", "operator-1"), false);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
