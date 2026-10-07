import assert from "node:assert/strict";
import test from "node:test";

import { createSofiaBrain } from "./executor.js";
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

  const report = await brain.run({ task: "Create hello.txt" });

  assert.equal(report.completed, true);
  assert.equal(report.state, "completed");
  assert.equal(writes, 2);
  assert.ok(events.includes("brain.subagent.completed"));
  assert.ok(events.includes("brain.verification.completed"));
});
