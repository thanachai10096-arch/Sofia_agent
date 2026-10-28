import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLearnedSkillCandidate } from "./skill-evaluation.js";
import type { SkillPackage } from "../skills/platform.js";

const candidate: SkillPackage = {
  source: "learned",
  version: "1.0.0",
  skill: {
    id: "learned:test-skill",
    name: "Test skill",
    description: "Candidate for evaluator contract test",
    triggers: ["test"],
    categories: ["tool_error"],
    strategy: "inspect-evidence",
    procedure: ["inspect evidence", "verify outcome"],
    verification: ["test"],
  },
};

test("metadata-valid learned skills remain unverified without isolated task fixtures", async () => {
  const result = await evaluateLearnedSkillCandidate(candidate);
  assert.equal(result.passed, false);
  assert.equal(result.checks.find((check) => check.name === "skill-metadata")?.passed, true);
  assert.equal(result.checks.find((check) => check.name === "procedure")?.passed, true);
  assert.equal(result.checks.find((check) => check.name === "verification")?.passed, true);
  assert.equal(result.checks.find((check) => check.name === "isolated-task-fixture-evaluation")?.passed, false);
});

test("candidate instructions cannot be treated as verified solely because metadata is valid", async () => {
  const result = await evaluateLearnedSkillCandidate(candidate);
  assert.equal(result.passed, false, "activation must wait for task-outcome evidence");
});
