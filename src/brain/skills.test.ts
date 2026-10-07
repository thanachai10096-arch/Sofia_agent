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
