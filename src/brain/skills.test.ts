import assert from "node:assert/strict";
import test from "node:test";

import { compactSkillContext, matchSkills } from "./skills.js";

test("matches a targeted skill without model inference", () => {
  const skills = matchSkills("type_error", "TS2339 property does not exist");
  assert.equal(skills[0]?.id, "typescript-error-repair");
  assert.ok(compactSkillContext(skills).length > 0);
});

test("dependency failures select dependency repair", () => {
  const skills = matchSkills("dependency_error", "Cannot find module");
  assert.equal(skills[0]?.id, "dependency-repair");
});


test("CI failures select evidence-first CI triage", () => {
  const skills = matchSkills("environment_error", "Windows CI failed with ENOTEMPTY in a cross-platform workflow run");
  assert.equal(skills[0]?.id, "ci-failure-triage");
  assert.ok(skills[0]?.procedure.some(step => step.includes("never skip")));
  assert.deepEqual(skills[0]?.verification, ["test", "build"]);
});


test("durable recovery skill preserves evidence and avoids duplicate dispatch", () => {
  const skills = matchSkills("runtime_error", "job recovery after restart has an indeterminate dispatch outcome");
  assert.equal(skills[0]?.id, "durable-job-recovery");
  assert.ok(skills[0]?.procedure.some(step => step.includes("do not resubmit automatically")));
  assert.deepEqual(skills[0]?.verification, ["test", "build"]);
});
