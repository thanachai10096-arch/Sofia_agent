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

test("privileged skills always require approval and entries are explicitly planned", () => {
  assert.ok(ADVANCED_SKILLS.every((skill) => skill.status === "planned"));
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
