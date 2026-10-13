// Modified for Sofia Agents Skill Engine integration on 2026-10-13; provenance notes: docs/engineering/CODE_PROVENANCE_AUDIT.md.
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
  assert.equal(apiContext.riskLevel, "high");
  assert.ok(Array.isArray(apiContext.requiredCapabilities));
  assert.ok(Array.isArray(apiContext.requiredPermissions));
  assert.equal(typeof apiContext.resourceLimits, "object");
  assert.equal(apiContext.retryLimit, 0);
  assert.deepEqual(apiContext.compatibility, { apiVersion: 1, capabilityContract: "sofia-adapter-v1" });
  assert.equal(apiContext.trustLevel, "first-party");
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


test("testing tasks prefer the test policy rather than a generic fallback", () => {
  const skills = matchSkills("tool_error", "run tests and inspect the test suite", 5);
  assert.equal(skills[0]?.id, "sofia.v1.test");
});
