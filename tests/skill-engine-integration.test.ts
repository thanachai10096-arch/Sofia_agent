import assert from "node:assert/strict";
import test from "node:test";

import { compactSkillContext, matchSkills } from "../src/brain/skills.js";

test("policy catalog is part of the real recovery skill selection path", () => {
  const skills = matchSkills("tool_error", "API integration contract mismatch", 5);
  assert.ok(skills.some((skill) => skill.id === "sofia.v1.api"));
  assert.ok(compactSkillContext(skills).some((item) =>
    typeof item === "object" && item !== null && "id" in item && item.id === "sofia.v1.api",
  ));
});

test("security policy can be selected for permission-related recovery", () => {
  const skills = matchSkills("permission_error", "permission boundary and authorization review", 5);
  assert.ok(skills.some((skill) => skill.id === "sofia.v1.security"));
});

test("legacy focused skills remain available for backwards compatibility", () => {
  assert.equal(matchSkills("type_error", "TS2339 property does not exist")[0]?.id, "typescript-error-repair");
  assert.equal(matchSkills("dependency_error", "Cannot find module")[0]?.id, "dependency-repair");
});

test("skill selection bounds context size and input length", () => {
  assert.ok(matchSkills("unknown", "x".repeat(100_000), 999).length <= 8);
});
