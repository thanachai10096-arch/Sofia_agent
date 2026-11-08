import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VersionedSkillLifecycle, getSkillCandidateDigest } from "./skill-lifecycle.js";
import { InMemorySkillsPlatform } from "../skills/platform.js";
import { createManagedSkillLearningHandler } from "./managed-skill-learning.js";
import type { LearnedSkillCandidate } from "./learning.js";

const artifact = {
  format: "sofia-node-skill-v1" as const,
  runtime: "node" as const,
  entrypoint: "index.mjs",
  files: { "index.mjs": "export function run() { return 42; }" },
};

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
    passed: true,
    checks: [{ name: "metadata-and-verification", passed: true }],
    runtimeVerification: {
      candidateDigest: getSkillCandidateDigest(skill),
      runnerId: "isolated-test-runner",
      isolatedWorkspaceId: "managed-skill-test-workspace",
      isolated: true as const,
      executedChecks: skill.skill.verification.map((name) => ({ name, passed: true })),
      completedAt: new Date().toISOString(),
    },
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
    }, async () => artifact);
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
    const noArtifactCompiler = createManagedSkillLearningHandler(f.lifecycle, async () => true);
    assert.equal(await noArtifactCompiler(candidate, "run-2"), false);
    const declined = createManagedSkillLearningHandler(f.lifecycle, async () => false, async () => artifact);
    assert.equal(await declined(candidate, "run-3"), false);
    assert.equal(f.platform.get("learned:repair-type_error:type_error"), undefined);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
