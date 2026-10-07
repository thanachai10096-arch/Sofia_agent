import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemorySkillLedger, rankLearnedSkills } from "../src/brain/learning.js";

test("skill confidence rises after verified success", () => {
  const ledger = new InMemorySkillLedger();
  ledger.record({
    name: "repair-type",
    trigger: "TypeScript does not exist",
    category: "type_error",
    strategy: "fix-implementation",
    procedure: ["inspect", "patch", "typecheck"],
    verification: ["typecheck"],
    evidenceIds: ["e1"],
  });
  ledger.recordOutcome!({ skillName: "repair-type", success: true, evidenceIds: ["e2"] });
  const skill = ledger.list()[0]!;
  assert.equal(skill.attempts, 1);
  assert.equal(skill.successes, 1);
  assert.ok((skill.confidence ?? 0) > 0.55);
});

test("ranking prefers matching category and successful history", () => {
  const ranked = rankLearnedSkills([
    {
      name: "weak",
      trigger: "unrelated",
      category: "runtime_error",
      strategy: "fix-implementation",
      procedure: [],
      verification: [],
      evidenceIds: [],
      confidence: 0.6,
      attempts: 10,
      successes: 2,
      failures: 8,
    },
    {
      name: "strong",
      trigger: "TypeScript does not exist",
      category: "type_error",
      strategy: "fix-implementation",
      procedure: ["inspect"],
      verification: ["typecheck"],
      evidenceIds: ["e1"],
      confidence: 0.9,
      attempts: 10,
      successes: 9,
      failures: 1,
    },
  ], "type_error", "TypeScript does not exist");
  assert.equal(ranked[0]?.skill.name, "strong");
});

test("failure memory keeps a stable fingerprint and resolved status", () => {
  const ledger = new InMemorySkillLedger();
  ledger.recordFailure!({
    id: "failure:f1",
    fingerprint: "f1",
    category: "dependency_error",
    message: "module not found",
    attempts: 1,
    resolved: false,
    evidenceIds: ["e1"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  ledger.recordFailure!({
    id: "failure:f1",
    fingerprint: "f1",
    category: "dependency_error",
    message: "module not found",
    attempts: 2,
    resolved: true,
    evidenceIds: ["e2"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const failure = ledger.listFailures!()[0]!;
  assert.equal(failure.attempts, 2);
  assert.equal(failure.resolved, true);
});
