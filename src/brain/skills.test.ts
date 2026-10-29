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


test("learned skills match accumulated trigger variants and outrank generic category matches", () => {
  const learned = {
    name: "workflow-review-a1b2",
    trigger: "Review this TypeScript pull request",
    triggers: ["Review this TypeScript pull request", "Review a TypeScript PR for regressions"],
    category: "unknown" as const,
    strategy: "initial" as const,
    procedure: ["inspect changed files", "check CI evidence", "summarize verified findings"],
    verification: ["test", "build"],
    evidenceIds: ["run-1", "run-2"],
  };
  const skills = matchSkills("unknown", "Please review a TypeScript PR for regressions", 5, {
    record() {},
    list() { return [learned]; },
  });
  assert.equal(skills[0]?.id, "learned:workflow-review-a1b2:unknown");
});
