import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VersionedSkillLifecycle } from "./skill-lifecycle.js";
import { InMemorySkillsPlatform, type SkillPackage } from "../skills/platform.js";

const skillPackage = (version: string): SkillPackage => ({
  skill: {
    id: "existing-unmanaged-skill",
    name: "Existing skill",
    description: "Skill lifecycle collision test",
    triggers: ["collision test"],
    categories: ["tool_error"],
    strategy: "inspect-evidence",
    procedure: ["inspect evidence", "verify outcome"],
    verification: ["test"],
  },
  source: "custom",
  version,
});

test("lifecycle refuses to overwrite an unmanaged platform skill", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-skill-collision-"));
  try {
    const platform = new InMemorySkillsPlatform();
    platform.register(skillPackage("0.9.0"));
    const lifecycle = new VersionedSkillLifecycle(
      platform,
      async () => ({ passed: true, checks: [{ name: "policy-and-regression-tests", passed: true }] }),
      { file: path.join(directory, "lifecycle.json") },
    );
    const candidate = lifecycle.propose(skillPackage("1.0.0"), {
      source: "test-suite",
      evidenceIds: ["collision-test"],
      confidence: 0.95,
    });
    const evaluated = await lifecycle.evaluate(candidate.id);
    assert.equal(evaluated.status, "verified");

    assert.throws(
      () => lifecycle.promote(candidate.id),
      /Cannot promote over an unmanaged skill/,
    );
    assert.equal(platform.get("existing-unmanaged-skill")?.version, "0.9.0");
    assert.equal(lifecycle.active("existing-unmanaged-skill"), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
