import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VersionedSkillLifecycle } from "./skill-lifecycle.js";
import { runSkillLifecycleWorkflow } from "./skill-lifecycle-workflow.js";
import { InMemorySkillsPlatform, type SkillPackage } from "../skills/platform.js";

function fixture(passes = true) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-skill-workflow-"));
  const platform = new InMemorySkillsPlatform();
  const lifecycle = new VersionedSkillLifecycle(platform, async () => ({
    passed: passes,
    checks: [{ name: "policy-and-regression-tests", passed: passes }],
  }), { file: path.join(directory, "lifecycle.json") });
  const skillPackage: SkillPackage = {
    skill: {
      id: "workflow-test-skill",
      name: "Workflow test skill",
      description: "Test-only skill metadata",
      triggers: ["workflow test"],
      categories: ["tool_error"],
      strategy: "inspect-evidence",
      procedure: ["inspect evidence", "verify outcome"],
      verification: ["test"],
    },
    source: "custom",
    version: "1.0.0",
  };
  return { directory, platform, lifecycle, skillPackage };
}

test("skill workflow activates only after successful evaluation and explicit approval", async () => {
  const f = fixture();
  try {
    const result = await runSkillLifecycleWorkflow(f.lifecycle, f.skillPackage, {
      source: "test-suite", evidenceIds: ["test-1"], confidence: 0.95,
    }, { approvePromotion: async () => true });
    assert.equal(result.activated, true);
    assert.equal(result.reason, "promoted");
    assert.equal(f.platform.get("workflow-test-skill")?.version, "1.0.0");
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("skill workflow never promotes when evaluation fails", async () => {
  const f = fixture(false);
  let approvalAsked = false;
  try {
    const result = await runSkillLifecycleWorkflow(f.lifecycle, f.skillPackage, {
      source: "test-suite", evidenceIds: ["test-2"], confidence: 0.95,
    }, { approvePromotion: async () => { approvalAsked = true; return true; } });
    assert.equal(result.activated, false);
    assert.equal(result.reason, "evaluation_rejected");
    assert.equal(approvalAsked, false);
    assert.equal(f.platform.get("workflow-test-skill"), undefined);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("skill workflow keeps verified candidates inactive when approval is declined", async () => {
  const f = fixture();
  try {
    const result = await runSkillLifecycleWorkflow(f.lifecycle, f.skillPackage, {
      source: "test-suite", evidenceIds: ["test-3"], confidence: 0.95,
    }, { approvePromotion: async () => false });
    assert.equal(result.activated, false);
    assert.equal(result.reason, "approval_declined");
    assert.equal(result.candidate.status, "verified");
    assert.equal(f.platform.get("workflow-test-skill"), undefined);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
