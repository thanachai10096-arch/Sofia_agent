import assert from "node:assert/strict";
import test from "node:test";

import { allBuiltinSkills, compactSkillContext, matchSkills } from "./skills.js";

test("matches a targeted skill without model inference", () => {
  const skills = matchSkills("type_error", "TS2339 property does not exist");
  assert.equal(skills[0]?.id, "typescript-error-repair");
  assert.ok(compactSkillContext(skills).length > 0);
});

test("dependency failures select dependency repair", () => {
  const skills = matchSkills("dependency_error", "Cannot find module");
  assert.equal(skills[0]?.id, "dependency-repair");
});

test("expanded catalog includes distinct engineering and operations skills", () => {
  const ids = new Set(allBuiltinSkills().map((skill) => skill.id));
  for (const id of [
    "ci-failure-triage",
    "git-change-safety",
    "api-integration-repair",
    "security-boundary-review",
    "browser-workflow-recovery",
    "repository-orientation",
    "structured-data-validation",
    "documentation-accuracy",
    "bounded-task-planning",
    "research-evidence-synthesis",
    "workspace-file-operations",
    "token-and-cost-budgeting",
    "multi-agent-handoff",
  ]) {
    assert.ok(ids.has(id), `missing built-in skill: ${id}`);
  }
  assert.ok(ids.size >= 12, "catalog should retain the original skills and add new ones");
});

test("CI and security messages select relevant recovery procedures", () => {
  assert.equal(matchSkills("environment_error", "GitHub Actions cross-platform build failed")[0]?.id, "ci-failure-triage");
  assert.equal(matchSkills("permission_error", "permission denied while checking path traversal")[0]?.id, "security-boundary-review");
});

test("browser failure prefers browser recovery over generic network handling", () => {
  assert.equal(matchSkills("network_error", "Playwright page timeout; element not found")[0]?.id, "browser-workflow-recovery");
});

test("research, workspace, cost, and delegation requests match focused skills", () => {
  assert.equal(matchSkills("unknown", "research latest evidence and compare sources")[0]?.id, "research-evidence-synthesis");
  assert.equal(matchSkills("permission_error", "path traversal while editing file path in workspace")[0]?.id, "workspace-file-operations");
  assert.equal(matchSkills("environment_error", "token budget and context window usage")[0]?.id, "token-and-cost-budgeting");
  assert.equal(matchSkills("unknown", "delegate this bounded subtask to a subagent")[0]?.id, "multi-agent-handoff");
});

test("skill selection is bounded and deterministic", () => {
  const first = matchSkills("tool_error", "API request failed; timeout in GitHub Actions", 2).map((skill) => skill.id);
  const second = matchSkills("tool_error", "API request failed; timeout in GitHub Actions", 2).map((skill) => skill.id);
  assert.equal(first.length, 2);
  assert.deepEqual(first, second);
});

test("compact context exposes procedure and verification but not full descriptions", () => {
  const context = compactSkillContext(matchSkills("environment_error", "CI workflow failed"));
  assert.ok(context.length > 0);
  assert.ok("procedure" in (context[0] as object));
  assert.ok("verification" in (context[0] as object));
  assert.ok(!("description" in (context[0] as object)));
});
