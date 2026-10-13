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


test("malformed learning ledger entries cannot crash or influence recovery", () => {
  const hostile = Object.defineProperty({}, "name", {
    enumerable: true,
    get() { throw new Error("must not execute getter"); },
  });
  const ledger = {
    record() {},
    list: () => [hostile as never],
  };
  assert.equal(matchSkills("tool_error", "API integration contract mismatch", 5, ledger).some(
    (skill) => skill.id === "sofia.v1.api",
  ), true);
  const brokenLedger = {
    record() {},
    list() { throw new Error("ledger unavailable"); },
  };
  assert.doesNotThrow(() => matchSkills("tool_error", "API integration contract mismatch", 5, brokenLedger));
});
