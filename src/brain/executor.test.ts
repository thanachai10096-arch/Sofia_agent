import assert from "node:assert/strict";
import test from "node:test";

import { createSofiaBrain } from "./executor.js";
import type { BrainReasoner, ToolGateway, ToolResult } from "./types.js";

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
