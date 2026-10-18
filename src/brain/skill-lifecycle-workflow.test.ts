import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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


test("skill lifecycle rejects tampered persisted active records before restoring them", () => {
  const scenarios = [
    {
      name: "missing evaluation",
      mutate: (record: Record<string, unknown>) => { delete record.evaluation; },
      activeBySkill: { "persisted-skill": "record-1" },
    },
    {
      name: "failed evaluation",
      mutate: (record: Record<string, unknown>) => {
        record.evaluation = { passed: false, checks: [{ name: "metadata", passed: false }] };
      },
      activeBySkill: { "persisted-skill": "record-1" },
    },
    {
      name: "low confidence",
      mutate: (record: Record<string, unknown>) => {
        record.provenance = { source: "test", evidenceIds: ["evidence-1"], confidence: 0.1 };
      },
      activeBySkill: { "persisted-skill": "record-1" },
    },
    {
      name: "inconsistent active pointer",
      mutate: (_record: Record<string, unknown>) => {},
      activeBySkill: { "persisted-skill": "missing-record" },
    },
  ];

  for (const scenario of scenarios) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-skill-store-tamper-"));
    try {
      const record: Record<string, unknown> = {
        id: "record-1",
        skillId: "persisted-skill",
        package: {
          skill: {
            id: "persisted-skill",
            name: "Persisted test skill",
            description: "Test-only persisted skill",
            triggers: ["test trigger"],
            categories: ["tool_error"],
            strategy: "inspect-evidence",
            procedure: ["inspect evidence", "verify outcome"],
            verification: ["test"],
          },
          source: "learned",
          version: "1.0.0",
        },
        status: "active",
        provenance: { source: "test", evidenceIds: ["evidence-1"], confidence: 0.95 },
        evaluation: { passed: true, checks: [{ name: "metadata", passed: true }] },
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
      scenario.mutate(record);
      writeFileSync(path.join(directory, "lifecycle.json"), JSON.stringify({
        schemaVersion: 1,
        records: [record],
        activeBySkill: scenario.activeBySkill,
      }));
      const platform = new InMemorySkillsPlatform();
      assert.throws(() => new VersionedSkillLifecycle(
        platform,
        async () => ({ passed: true, checks: [{ name: "unused", passed: true }] }),
        { file: path.join(directory, "lifecycle.json") },
      ), /Active skill lifecycle|inconsistent/);
      assert.equal(platform.get("persisted-skill"), undefined, scenario.name);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
