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

test("managed skill learning activates only after explicit approval", async () => {
  const f = fixture();
  const approvalCalls: Array<{ toolName: string; risk: string }> = [];
  try {
    const handler = createManagedSkillLearningHandler(f.lifecycle, async (request) => {
      approvalCalls.push({ toolName: request.toolName, risk: request.risk });
      return true;
    });
    assert.equal(await handler(candidate, "run-1", "operator-1"), true);
    assert.equal(approvalCalls.length, 1);
    assert.equal(approvalCalls[0]?.toolName, "skill.lifecycle.promote");
    assert.equal(approvalCalls[0]?.risk, "high");
    assert.equal(f.platform.get("learned:repair-type_error:type_error")?.source, "learned");
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("managed skill learning fails closed when approval is absent or declined", async () => {
  const f = fixture();
  try {
    const noApproval = createManagedSkillLearningHandler(f.lifecycle);
    assert.equal(await noApproval(candidate, "run-2"), false);
    const declined = createManagedSkillLearningHandler(f.lifecycle, async () => false);
    assert.equal(await declined(candidate, "run-3"), false);
    assert.equal(f.platform.get("learned:repair-type_error:type_error"), undefined);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
