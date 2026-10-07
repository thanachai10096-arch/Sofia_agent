import assert from "node:assert/strict";
import test from "node:test";
import { reviewCodeChange } from "./code-review.js";

const verification = [{
  criterionId: "typecheck",
  passed: true,
  detail: "Typecheck passed",
  evidenceIds: ["e1"],
  workspaceRevision: "r1",
}];

test("code review approves verified changes", () => {
  const result = reviewCodeChange({
    task: "Implement the feature",
    changedFiles: ["src/feature.ts"],
    verification,
    diff: "+export function feature() {}",
  });
  assert.equal(result.approved, true);
  assert.equal(result.findings.length, 0);
});

test("code review rejects failed verification", () => {
  const result = reviewCodeChange({
    task: "Fix the feature",
    changedFiles: ["src/feature.ts"],
    verification: [{ ...verification[0], passed: false, detail: "Tests failed" }],
  });
  assert.equal(result.approved, false);
  assert.equal(result.repairCategory, "incomplete_solution");
});

test("code review detects secrets in the diff", () => {
  const result = reviewCodeChange({
    task: "Add configuration",
    changedFiles: ["src/config.ts"],
    verification,
    diff: '+const apiKey = "super-secret-value";',
  });
  assert.equal(result.approved, false);
  assert.equal(result.findings.some((item) => item.category === "security"), true);
});

test("code review rejects a coding task with no observed changes", () => {
  const result = reviewCodeChange({
    task: "Implement the feature",
    changedFiles: [],
    verification,
  });
  assert.equal(result.approved, false);
  assert.equal(result.findings.some((item) => item.category === "scope"), true);
});
