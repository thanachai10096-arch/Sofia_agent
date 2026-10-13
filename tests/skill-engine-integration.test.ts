import assert from "node:assert/strict";
import test from "node:test";

import { compactSkillContext, matchSkills } from "../src/brain/skills.js";

test("policy catalog is part of the real recovery skill selection path", () => {
  const skills = matchSkills("tool_error", "API integration contract mismatch", 5);
  assert.ok(skills.some((skill) => skill.id === "sofia.v1.api"));
  const context = compactSkillContext(skills);
  const apiContext = context.find((item): item is Record<string, unknown> =>
    typeof item === "object" && item !== null && !Array.isArray(item) &&
    "id" in item && item.id === "sofia.v1.api",
  );
  assert.ok(apiContext);
  assert.ok(Array.isArray(apiContext.preconditions));
  assert.ok(Array.isArray(apiContext.failureConditions));
  assert.ok(Array.isArray(apiContext.recovery));
  assert.equal(apiContext.risk, "may-write");
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
