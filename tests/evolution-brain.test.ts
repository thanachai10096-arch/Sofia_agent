// Modified for Sofia Agents Skill Engine integration on 2026-10-13; provenance notes: docs/engineering/CODE_PROVENANCE_AUDIT.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSofiaBrain } from "../src/brain/executor.js";
import { EvolutionEngine } from "../src/brain/evolution.js";
import type { BrainReasoner, ToolGateway, ToolResult } from "../src/brain/types.js";

test("Brain learns a repair skill only after a failed action is repaired and verified", async () => {
  const evolution = new EvolutionEngine();
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  let writeAttempts = 0;

  const tools = {
    describe(name: string) {
      if (["workspace.write_file", "git.diff", "verify.acceptance"].includes(name)) {
        return { effects: name === "workspace.write_file" ? ["write" as const] : ["read" as const] };
      }
      return undefined;
    },
    async execute(call: { tool: string; input: Record<string, unknown> }): Promise<ToolResult> {
      calls.push(call);
      if (call.tool === "workspace.write_file") {
        writeAttempts += 1;
        if (writeAttempts === 1) {
          return {
            ok: false,
            data: null,
            evidenceId: "write-failed",
            error: { category: "runtime_error", message: "test assertion expected value but received another value" },
          };
        }
        return { ok: true, data: { written: true }, evidenceId: "write-fixed" };
      }
      if (call.tool === "verify.acceptance") {
        return { ok: true, data: { passed: true }, evidenceId: "verified" };
      }
      if (call.tool === "git.diff") {
        return { ok: true, data: { diff: "diff --git a/src/example.ts b/src/example.ts" }, evidenceId: "diff" };
      }
      return { ok: false, data: null, evidenceId: "unknown", error: { category: "tool_error", message: "unexpected tool" } };
    },
    async snapshot() { return { id: "snapshot", revision: "rev-1", evidenceId: "snapshot-evidence" }; },
    async changedFiles() { return ["src/example.ts"]; },
    async checkpoint() { return { id: "checkpoint", revision: "rev-1" }; },
    async rollback() { return []; },
  } as unknown as ToolGateway;

  const reasoner: BrainReasoner = {
    async prepare(request) {
      const parsed = JSON.parse(request) as { phase: string };
      return {
        inputTokens: 10,
        async invoke() {
          assert.equal(parsed.phase, "replan");
          return {
            value: {
              strategy: "fix-implementation",
              reason: "Apply a targeted repair after the failed assertion",
              steps: [{
                id: "write-fixed",
                objective: "Write the repaired implementation",
                dependencies: [],
                call: { tool: "workspace.write_file", input: { path: "src/example.ts", content: "fixed" } },
              }],
            },
            usage: { inputTokens: 10, outputTokens: 10 },
          };
        },
      };
    },
  };

  const brain = createSofiaBrain({
    dependencies: { reasoner, tools, evolution },
    limits: { maxModelCalls: 4, maxReplans: 2 },
  });

  const report = await brain.run({
    task: "Fix the failing test assertion in the implementation",
    understanding: {
      objective: "Fix a test failure",
      constraints: [],
      assumptions: [],
      requiredCapabilities: ["coding"],
      requiredTools: ["workspace.write_file"],
      risk: "low",
      successCriteria: ["The repaired implementation passes verification"],
      ambiguities: [],
    },
    plan: {
      strategy: "initial",
      reason: "Attempt the requested implementation",
      steps: [{
        id: "write-initial",
        objective: "Write the initial implementation",
        dependencies: [],
        call: { tool: "workspace.write_file", input: { path: "src/example.ts", content: "initial" } },
      }],
    },
    acceptanceCriteria: [{
      id: "acceptance",
      description: "The implementation passes its acceptance check",
      probe: { tool: "verify.acceptance", input: {} },
      evaluate(data) {
        return { passed: (data as { passed?: boolean }).passed === true, detail: "Acceptance check passed" };
      },
    }],
  });

  assert.equal(report.completed, true, report.summary);
  assert.equal(writeAttempts, 2);
  assert.ok(calls.some((call) => call.tool === "verify.acceptance"));
  const learned = evolution.getSkill("test-failure-repair");
  assert.ok(learned, "the matching repair skill should be selected during replanning");
  assert.equal(learned.successes, 1, "a skill earns success only after verification and code review pass");
  assert.equal(learned.failures, 0);
  assert.equal(evolution.getSnapshot().taskTypes.coding?.successes, 1);
});


test("policy skill success is learned only from observed test metrics and review", async () => {
  const evolution = new EvolutionEngine();
  let writeAttempts = 0;
  const tools = {
    describe(name: string) {
      if (name === "workspace.write_file") return { effects: ["write" as const] };
      if (["project.verify", "git.diff"].includes(name)) return { effects: ["read" as const] };
      return undefined;
    },
    async execute(call: { tool: string; input: Record<string, unknown> }): Promise<ToolResult> {
      if (call.tool === "workspace.write_file") {
        writeAttempts += 1;
        if (writeAttempts === 1) {
          return {
            ok: false,
            data: null,
            evidenceId: "write-failed",
            error: { category: "tool_error", message: "run tests and inspect the test suite before retrying" },
          };
        }
        return { ok: true, data: { written: true }, evidenceId: "write-fixed" };
      }
      if (call.tool === "project.verify") {
        return {
          ok: true,
          data: {
            passed: true,
            code: 0,
            testsTotal: 12,
            passedTests: 12,
            failedTests: 0,
            skippedTests: 0,
            cancelledTests: 0,
            todoTests: 0,
          },
          evidenceId: "verify-" + String(call.input.kind),
        };
      }
      if (call.tool === "git.diff") {
        return { ok: true, data: { diff: "diff --git a/src/example.ts b/src/example.ts\n+fixed" }, evidenceId: "diff" };
      }
      return { ok: false, data: null, evidenceId: "unexpected", error: { category: "tool_error", message: "unexpected tool" } };
    },
    async snapshot() { return { id: "snapshot", revision: "rev-1", evidenceId: "snapshot-evidence" }; },
    async changedFiles() { return ["src/example.ts"]; },
    async checkpoint() { return { id: "checkpoint", revision: "rev-1" }; },
    async rollback() { return []; },
  } as unknown as ToolGateway;
  const reasoner: BrainReasoner = {
    async prepare(request) {
      const parsed = JSON.parse(request) as { phase: string };
      assert.equal(parsed.phase, "replan");
      return {
        inputTokens: 10,
        async invoke() {
          return {
            value: {
              strategy: "fix-implementation",
              reason: "Use the testing policy after a tool failure",
              steps: [{
                id: "write-fixed",
                objective: "Write the repaired implementation",
                dependencies: [],
                call: { tool: "workspace.write_file", input: { path: "src/example.ts", content: "fixed" } },
              }],
            },
            usage: { inputTokens: 10, outputTokens: 10 },
          };
        },
      };
    },
  };
  const brain = createSofiaBrain({
    dependencies: { reasoner, tools, evolution },
    limits: { maxModelCalls: 4, maxReplans: 2 },
  });
  const report = await brain.run({
    task: "Repair the failed verification by running tests",
    understanding: {
      objective: "Repair the failed verification",
      constraints: [],
      assumptions: [],
      requiredCapabilities: ["coding"],
      requiredTools: ["workspace.write_file"],
      risk: "low",
      successCriteria: ["typecheck, tests, build, and code review pass"],
      ambiguities: [],
    },
    plan: {
      strategy: "initial",
      reason: "Attempt the requested repair",
      steps: [{
        id: "write-initial",
        objective: "Write initial implementation",
        dependencies: [],
        call: { tool: "workspace.write_file", input: { path: "src/example.ts", content: "initial" } },
      }],
    },
  });
  assert.equal(report.completed, true, report.summary);
  assert.equal(writeAttempts, 2);
  const skill = evolution.getSkill("sofia.v1.test");
  assert.ok(skill, "the policy test skill should be selected and verified");
  assert.equal(skill.successes, 1);
  assert.equal(skill.failures, 0);
  assert.equal(skill.taskTypes.testing?.successes, 1, "success should be scoped to the selected skill task type");
  assert.equal(skill.taskTypes.coding?.successes ?? 0, 0, "capability labels must not be misused as task types");
});
