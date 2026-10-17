import assert from "node:assert/strict";
import test from "node:test";

import { createSofiaBrain } from "./executor.js";
import { InMemorySkillLedger } from "./learning.js";
import type { BrainReasoner, ToolGateway, ToolResult } from "./types.js";
import type { SubagentRuntime } from "./subagents.js";

const plan = {
  strategy: "initial",
  reason: "Inspect and write the requested file.",
  steps: [
    {
      id: "write",
      objective: "Write the implementation",
      dependencies: [],
      call: {
        tool: "workspace.write_file",
        input: { path: "hello.txt", content: "hello" },
      },
    },
  ],
};

function makeReasoner(): BrainReasoner {
  return {
    async prepare(request) {
      const parsed = JSON.parse(request) as { phase: string };
      const value =
        parsed.phase === "understand"
          ? {
              objective: "Write a file",
              constraints: [],
              assumptions: [],
              requiredCapabilities: ["file-write"],
              requiredTools: ["workspace.write_file"],
              risk: "low",
              successCriteria: ["hello.txt exists"],
              ambiguities: [],
            }
          : parsed.phase === "replan"
            ? {
                strategy: "fix-implementation",
                reason: "Verify the recovered workspace state.",
                steps: [
                  {
                    id: "inspect",
                    objective: "Inspect the recovered file",
                    dependencies: [],
                    call: {
                      tool: "workspace.list_files",
                      input: { path: "." },
                    },
                  },
                ],
              }
            : plan;

      return {
        inputTokens: 10,
        async invoke() {
          return {
            value,
            usage: { inputTokens: 10, outputTokens: 20 },
          };
        },
      };
    },
  };
}

function makeTools(): ToolGateway {
  let revision = 0;

  const result = (data: unknown): ToolResult => ({
    ok: true,
    data,
    evidenceId: `e-${++revision}`,
  });

  return {
    describe(name) {
      return name === "workspace.write_file" || name === "workspace.list_files"
        ? { effects: name === "workspace.write_file" ? ["write"] : ["read"] }
        : undefined;
    },
    async execute(call) {
      if (call.tool === "workspace.write_file") return result({ ok: true });
      if (call.tool === "workspace.list_files") return result(["hello.txt"]);
      return { ok: false, data: null, evidenceId: `e-${++revision}`, error: { category: "tool_error", message: "unknown" } };
    },
    async snapshot() {
      return { id: `s-${++revision}`, revision: String(revision), evidenceId: `e-${revision}` };
    },
    async changedFiles() {
      return ["hello.txt"];
    },
    async checkpoint() {
      return { id: "cp-1", revision: "0" };
    },
    async rollback() {
      return [];
    },
  };
}

test("Brain completes a coding loop only after trusted verification", async () => {
  const brain = createSofiaBrain({
    dependencies: {
      reasoner: makeReasoner(),
      tools: makeTools(),
      allowShell: false,
      allowNetwork: false,
    },
    limits: {
      maxSteps: 4,
      maxToolCalls: 10,
      maxReplans: 1,
      maxModelCalls: 4,
      maxTokens: 1_000,
      maxContextTokens: 500,
      maxOutputTokens: 100,
      timeoutMs: 5_000,
    },
  });

  const report = await brain.run({
    task: "Create hello.txt",
    acceptanceCriteria: [
      {
        id: "file-exists",
        description: "hello.txt exists",
        probe: { tool: "workspace.list_files", input: { path: "." } },
        evaluate(data) {
          return {
            passed: Array.isArray(data) && data.includes("hello.txt"),
            detail: "hello.txt exists",
          };
        },
      },
    ],
  });

  assert.equal(report.completed, true);
  assert.equal(report.state, "completed");
  assert.deepEqual(report.changedFiles, ["hello.txt"]);
  assert.equal(report.verification[0]?.passed, true);
  assert.equal(report.usage.modelCalls, 2);
});


test("Brain feeds a failed verification into a specialist and executes its validated proposal", async () => {
  let writes = 0;
  const events: string[] = [];

  const tools = makeTools();
  const originalExecute = tools.execute.bind(tools);
  tools.execute = async (call, context) => {
    if (call.tool === "workspace.write_file") {
      writes += 1;
      if (writes === 1) {
        return {
          ok: false,
          data: null,
          evidenceId: "failure-1",
          error: { category: "tool_error", message: "initial write failed" },
        };
      }
    }
    return originalExecute(call, context);
  };

  const subagents: SubagentRuntime = {
    async run(request) {
      assert.equal(request.role, "debugger");
      assert.equal(request.context && typeof request.context === "object", true);
      return {
        role: "debugger",
        summary: "Retry the file write.",
        output: "validated recovery proposal",
        proposedAction: {
          tool: "workspace.write_file",
          input: { path: "hello.txt", content: "hello" },
          reason: "The write failure is recoverable; retry the same bounded action.",
        },
      };
    },
  };

  const brain = createSofiaBrain({
    dependencies: {
      reasoner: makeReasoner(),
      tools,
      subagents,
      allowShell: false,
      allowNetwork: false,
      onEvent(event) {
        events.push(event.type);
      },
    },
    limits: {
      maxSteps: 4,
      maxToolCalls: 20,
      maxReplans: 1,
      maxModelCalls: 4,
      maxTokens: 1_000,
      maxContextTokens: 500,
      maxOutputTokens: 100,
      timeoutMs: 5_000,
    },
  });

  const report = await brain.run({
    task: "Create hello.txt",
    acceptanceCriteria: [{
      id: "file-exists",
      description: "hello.txt exists",
      probe: { tool: "workspace.list_files", input: { path: "." } },
      evaluate(data) {
        return {
          passed: Array.isArray(data) && data.includes("hello.txt"),
          detail: "hello.txt exists",
        };
      },
    }],
  });

  assert.equal(report.completed, true, report.summary);
  assert.equal(report.state, "completed", report.summary);
  assert.equal(writes, 2, report.summary);
  assert.ok(events.includes("brain.subagent.completed"));
  assert.equal(events.includes("brain.replan.started"), false);
  assert.ok(events.includes("brain.verification.completed"));

  const trace = brain.getExecutionTrace();
  assert.ok(trace.length > 0);
  assert.equal(trace[0]?.runId, brain.runId);
  assert.deepEqual(
    trace.map((entry) => entry.sequence),
    trace.map((entry) => entry.sequence).slice().sort((a, b) => a - b),
  );
  assert.ok(trace.some((entry) => entry.type === "brain.subagent.completed"));
  assert.ok(trace.some((entry) => entry.type === "brain.verification.completed"));
});


test("Brain can resume from a saved run snapshot without repeating completed steps", async () => {
  let writes = 0;
  const controller = new AbortController();
  let saved: import("./run-state.js").BrainRunSnapshot | undefined;

  const tools = makeTools();
  const originalExecute = tools.execute.bind(tools);
  tools.execute = async (call, context) => {
    if (call.tool === "workspace.write_file") writes += 1;
    return originalExecute(call, context);
  };

  const first = createSofiaBrain({
    dependencies: {
      reasoner: makeReasoner(),
      tools,
      allowShell: false,
      allowNetwork: false,
      onRunSnapshot(snapshot) {
        if (snapshot.completedStepIds.length > 0) {
          saved = snapshot;
          controller.abort(new Error("simulated worker restart"));
        }
      },
    },
    limits: {
      maxSteps: 4,
      maxToolCalls: 10,
      maxReplans: 1,
      maxModelCalls: 4,
      maxTokens: 1_000,
      maxContextTokens: 500,
      maxOutputTokens: 100,
      timeoutMs: 5_000,
    },
  });

  const cancelled = await first.run({
    task: "Create hello.txt",
    signal: controller.signal,
    acceptanceCriteria: [
      {
        id: "file-exists",
        description: "hello.txt exists",
        probe: { tool: "workspace.list_files", input: { path: "." } },
        evaluate(data) {
          return {
            passed: Array.isArray(data) && data.includes("hello.txt"),
            detail: "hello.txt exists",
          };
        },
      },
    ],
  });

  assert.equal(cancelled.completed, false);
  assert.ok(saved);
  assert.equal(writes, 1);

  const resumed = createSofiaBrain({
    dependencies: {
      reasoner: makeReasoner(),
      tools,
      allowShell: false,
      allowNetwork: false,
    },
    limits: {
      maxSteps: 4,
      maxToolCalls: 10,
      maxReplans: 1,
      maxModelCalls: 4,
      maxTokens: 1_000,
      maxContextTokens: 500,
      maxOutputTokens: 100,
      timeoutMs: 5_000,
    },
  });

  const report = await resumed.run({
    task: "Create hello.txt",
    resume: saved,
    acceptanceCriteria: [
      {
        id: "file-exists",
        description: "hello.txt exists",
        probe: { tool: "workspace.list_files", input: { path: "." } },
        evaluate(data) {
          return {
            passed: Array.isArray(data) && data.includes("hello.txt"),
            detail: "hello.txt exists",
          };
        },
      },
    ],
  });

  assert.equal(report.completed, true, report.summary);
  assert.equal(report.state, "completed", report.summary);
  assert.equal(writes, 1, report.summary);
});


test("Brain emits a review gate after verification", async () => {
  const events: string[] = [];
  const brain = createSofiaBrain({
    dependencies: {
      reasoner: makeReasoner(),
      tools: makeTools(),
      allowShell: false,
      allowNetwork: false,
      onEvent(event) {
        events.push(event.type);
      },
    },
    limits: {
      maxSteps: 4,
      maxToolCalls: 10,
      maxReplans: 1,
      maxModelCalls: 4,
      maxTokens: 1_000,
      maxContextTokens: 500,
      maxOutputTokens: 100,
      timeoutMs: 5_000,
    },
  });

  const report = await brain.run({
    task: "Create hello.txt",
    acceptanceCriteria: [{
      id: "file-exists",
      description: "hello.txt exists",
      probe: { tool: "workspace.list_files", input: { path: "." } },
      evaluate(data) {
        return {
          passed: Array.isArray(data) && data.includes("hello.txt"),
          detail: "hello.txt exists",
        };
      },
    }],
  });

  assert.equal(report.completed, true);
  assert.ok(events.includes("brain.review.completed"));
});


test("Brain re-executes a completed step ID when a replan changes its action", async () => {
  let replannedActionCalls = 0;
  let failureCalls = 0;
  const reasoner: BrainReasoner = {
    async prepare(request) {
      const parsed = JSON.parse(request) as { phase: string };
      const value = parsed.phase === "understand"
        ? {
            objective: "Complete the task after a recoverable failure",
            constraints: [],
            assumptions: [],
            requiredCapabilities: ["file-write"],
            requiredTools: ["workspace.write_file"],
            risk: "low",
            successCriteria: ["replanned action runs"],
            ambiguities: [],
          }
        : parsed.phase === "replan"
          ? {
              strategy: "fix-implementation",
              reason: "The original step ID now represents a different action.",
              steps: [{
                id: "completed-step",
                objective: "Run the replacement action",
                dependencies: [],
                call: { tool: "workspace.list_files", input: { path: "replanned-step" } },
              }],
            }
          : {
              strategy: "initial",
              reason: "Write then exercise a recoverable failure.",
              steps: [
                {
                  id: "completed-step",
                  objective: "Write a baseline file",
                  dependencies: [],
                  call: { tool: "workspace.write_file", input: { path: "done.txt", content: "done" } },
                },
                {
                  id: "trigger-failure",
                  objective: "Trigger one recoverable failure",
                  dependencies: ["completed-step"],
                  call: { tool: "test.fail_once", input: {} },
                },
              ],
            };
      return {
        inputTokens: 10,
        async invoke() {
          return { value, usage: { inputTokens: 10, outputTokens: 20 } };
        },
      };
    },
  };

  let evidence = 0;
  const tools: ToolGateway = {
    describe(name) {
      if (name === "workspace.write_file" || name === "workspace.list_files" || name === "test.fail_once") {
        return { effects: name === "workspace.write_file" ? ["write"] : ["read"] };
      }
      return undefined;
    },
    async execute(call): Promise<ToolResult> {
      const evidenceId = "replan-evidence-" + (++evidence);
      if (call.tool === "test.fail_once") {
        failureCalls += 1;
        return {
          ok: false,
          data: null,
          evidenceId,
          error: { category: "tool_error", message: "recoverable test failure" },
        };
      }
      if (call.tool === "workspace.list_files" && call.input.path === "replanned-step") {
        replannedActionCalls += 1;
      }
      if (call.tool === "git.diff") return { ok: true, data: { diff: "test diff" }, evidenceId };
      return { ok: true, data: ["done.txt"], evidenceId };
    },
    async snapshot() {
      return { id: "replan-snapshot-" + evidence, revision: String(evidence), evidenceId: "replan-snapshot-evidence" };
    },
    async changedFiles() {
      return ["done.txt"];
    },
    async checkpoint() {
      return { id: "replan-checkpoint", revision: "0" };
    },
    async rollback() {
      return [];
    },
  };

  const skillLedger = new InMemorySkillLedger();
  const brain = createSofiaBrain({
    // No onSkillCandidate callback: learned-skill persistence must fail closed.
    dependencies: { reasoner, tools, allowShell: false, allowNetwork: false, skillLedger },
    limits: {
      maxSteps: 6,
      maxToolCalls: 20,
      maxReplans: 2,
      maxModelCalls: 6,
      maxTokens: 2_000,
      maxContextTokens: 500,
      maxOutputTokens: 100,
      timeoutMs: 5_000,
    },
  });
  const report = await brain.run({
    task: "Run replacement step after recovery",
    acceptanceCriteria: [{
      id: "file-exists",
      description: "done.txt exists",
      probe: { tool: "workspace.list_files", input: { path: "." } },
      evaluate(data) {
        return { passed: Array.isArray(data) && data.includes("done.txt"), detail: "baseline file exists" };
      },
    }],
  });

  assert.equal(failureCalls, 1);
  assert.equal(replannedActionCalls, 1, "changed action must not be skipped due to a reused step ID");
  assert.equal(report.completed, true, report.summary);
  assert.deepEqual(skillLedger.list(), [], "without an explicit approval callback, learned skills must not be recorded");
});
