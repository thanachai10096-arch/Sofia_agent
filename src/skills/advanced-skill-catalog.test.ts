import test from "node:test";
import assert from "node:assert/strict";
import {
  ADVANCED_SKILLS,
  ADVANCED_SKILL_COUNT,
  getAdvancedSkill,
  listAdvancedSkillsByCategory,
  validateAdvancedSkillCatalog,
} from "./advanced-skill-catalog.js";

test("advanced catalog contains exactly 100 unique skill IDs", () => {
  assert.equal(ADVANCED_SKILL_COUNT, 100);
  assert.equal(ADVANCED_SKILLS.length, 100);
  assert.equal(new Set(ADVANCED_SKILLS.map((skill) => skill.id)).size, 100);
  assert.deepEqual(validateAdvancedSkillCatalog(), []);
});

test("catalog contains ten domains with ten skills each", () => {
  const categories = new Set(ADVANCED_SKILLS.map((skill) => skill.category));
  assert.equal(categories.size, 10);
  for (const category of categories) {
    assert.equal(listAdvancedSkillsByCategory(category).length, 10, category);
  }
});

test("lookup returns a known skill and safely returns undefined for unknown IDs", () => {
  assert.equal(getAdvancedSkill("runtime.01")?.name, "Intent Clarifier");
  assert.equal(getAdvancedSkill("not-a-real-skill"), undefined);
});

test("privileged skills require approval and only tested core handlers are verified", () => {
  const verified = ADVANCED_SKILLS.filter((skill) => skill.status === "verified");
  assert.deepEqual(verified.map((skill) => skill.id).sort(), [
    "runtime.01", "runtime.02", "runtime.03", "runtime.08", "runtime.09", "runtime.10",
    "security.01", "security.02", "security.04", "security.05", "security.06",
    "conversation.02", "conversation.04", "conversation.05", "conversation.09",
    "coding.03", "testing.01", "testing.05", "testing.08", "testing.09",
  ].sort());
  assert.equal(ADVANCED_SKILLS.filter((skill) => skill.status === "planned").length, 80);
  assert.ok(ADVANCED_SKILLS.filter((skill) => skill.risk === "privileged").length > 0);
  assert.ok(ADVANCED_SKILLS
    .filter((skill) => skill.risk === "privileged")
    .every((skill) => skill.requiresApproval));
});

test("category lookup is case-insensitive and trims whitespace", () => {
  assert.equal(
    listAdvancedSkillsByCategory("  runtime & recovery ").length,
    10,
  );
});
