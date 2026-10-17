import test from "node:test";
import assert from "node:assert/strict";
import {
  codebaseSemanticSearch,
  implementationPlanner,
  refactoringPlanner,
  registerVerifiedCodingPlanningSkills,
  repositoryMapper,
  typeScriptDiagnosticTriage,
} from "./coding-planning-handlers.js";
import { AdvancedSkillRegistry } from "./advanced-skill-runtime.js";

test("repository mapper reports dependencies and unknown endpoints without filesystem claims", () => {
  const result = repositoryMapper({ paths: ["src/a.ts", "src/b.ts"], dependencies: [{ from: "src/a.ts", to: "src/b.ts" }, { from: "src/missing.ts", to: "src/a.ts" }] }) as {
    files: Array<{ path: string; importedBy: string[] }>; complete: boolean; filesystemInspected: boolean; unknownEndpoints: unknown[];
  };
  assert.deepEqual(result.files[1]?.importedBy, ["src/a.ts"]);
  assert.equal(result.complete, false);
  assert.equal(result.filesystemInspected, false);
  assert.equal(result.unknownEndpoints.length, 1);
});

test("codebase search uses token overlap only and identifies source coverage", () => {
  const result = codebaseSemanticSearch({ query: "workspace path policy", documents: [
    { id: "a", path: "src/security/guard.ts", content: "workspace path validation policy" },
    { id: "b", path: "docs/readme.md", content: "release notes" },
  ] }) as { results: Array<{ id: string; score: number }>; semanticModelUsed: boolean; sourceCoverage: string };
  assert.equal(result.results[0]?.id, "a");
  assert.equal(result.semanticModelUsed, false);
  assert.equal(result.sourceCoverage, "supplied-documents-only");
});

test("implementation planner includes inspect, verify, and review gates", () => {
  const result = implementationPlanner({ goal: "Add a small feature", candidateFiles: ["src/a.ts"], acceptanceCriteria: ["Existing API remains compatible"], constraints: ["No destructive changes"] }) as {
    steps: Array<{ id: string }>; planOnly: boolean; editsMade: boolean;
  };
  assert.deepEqual(result.steps.map(step => step.id), ["inspect", "plan", "implement", "verify", "review"]);
  assert.equal(result.planOnly, true);
  assert.equal(result.editsMade, false);
});

test("implementation planner rejects missing acceptance criteria", () => {
  assert.throws(() => implementationPlanner({ goal: "Feature", acceptanceCriteria: [] }), /acceptance criterion/);
});

test("TypeScript diagnostic triage groups supplied diagnostics and does not claim compiler execution", () => {
  const result = typeScriptDiagnosticTriage({ diagnostics: [
    { file: "src/a.ts", code: "TS2345", message: "Type mismatch", severity: "error" },
    { file: "src/a.ts", code: "TS6133", message: "Unused variable", severity: "warning" },
  ] }) as { byFile: Array<{ count: number }>; errorCount: number; warningCount: number; compilerExecuted: boolean };
  assert.equal(result.byFile[0]?.count, 2);
  assert.equal(result.errorCount, 1);
  assert.equal(result.warningCount, 1);
  assert.equal(result.compilerExecuted, false);
});

test("refactoring planner requires baseline and regression evidence", () => {
  const result = refactoringPlanner({ target: "Split a large module", modules: ["src/core.ts"], tests: ["tests/core.test.ts"], risks: ["Public API compatibility"] }) as {
    sequence: Array<{ evidenceRequired: boolean }>; safeToApplyAutomatically: boolean;
  };
  assert.ok(result.sequence.every(step => step.evidenceRequired));
  assert.equal(result.safeToApplyAutomatically, false);
});

test("verified coding planning skills register through the guarded dispatcher", async () => {
  const registry = new AdvancedSkillRegistry();
  const ids = registerVerifiedCodingPlanningSkills(registry);
  assert.deepEqual(ids, ["coding.01", "coding.02", "coding.04", "coding.06", "coding.09"]);
  assert.ok(ids.every(id => registry.has(id)));
  const result = await registry.execute("coding.04", {
    goal: "Add a small feature",
    candidateFiles: ["src/a.ts"],
    acceptanceCriteria: ["Existing API remains compatible"],
    constraints: ["No destructive changes"],
  }, { principalId: "test-user", signal: new AbortController().signal }) as { planOnly: boolean };
  assert.equal(result.planOnly, true);
});
