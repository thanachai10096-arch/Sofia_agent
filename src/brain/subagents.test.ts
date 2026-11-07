import assert from "node:assert/strict";
import test from "node:test";
import { createSubagentRuntime, isSubagentWorthyTask, roleForTask } from "./subagents.js";

test("subagent routing", async (t) => {
  await t.test("routes coding failures to debugger", () => {
    assert.equal(roleForTask("fix the broken TypeScript build", "type_error"), "debugger");
  });
  await t.test("routes security work internally", () => {
    assert.equal(roleForTask("review authentication and token handling"), "security");
  });
  await t.test("routes verification work to tester", () => {
    assert.equal(roleForTask("verify the regression tests"), "tester");
  });
});

test("subagent runtime executes a bounded internal role without exposing model selection", async () => {
  const runtime = createSubagentRuntime({
    async prepare() {
      return {
        inputTokens: 10,
        async invoke() {
          return {
            value: { finding: "inspect package boundaries" },
            usage: { inputTokens: 10, outputTokens: 20 },
          };
        },
      };
    },
  });
  const result = await runtime.run({
    role: "explorer",
    task: "inspect this project",
    signal: new AbortController().signal,
  });
  assert.equal(result.role, "explorer");
  assert.deepEqual(result.output, { finding: "inspect package boundaries" });
});


test("shared delegated tool runtime only exposes and accepts registered allowlisted tools", async () => {
  let prompt = "";
  const tools = {
    listTools() {
      return [
        { name: "workspace.write_file", description: "Write a workspace file", effects: ["write"] as const },
        { name: "tools.unknown", description: "Not registered in Sofia", effects: ["write"] as const },
        { name: "terminal.exec", description: "Not in the delegated allowlist", effects: ["shell"] as const },
      ];
    },
    async snapshot() {
      return { id: "snapshot", revision: "rev-1", evidenceId: "evidence-1" };
    },
  };
  const runtime = createSubagentRuntime({
    async prepare(request) {
      prompt = request;
      return {
        inputTokens: 10,
        async invoke() {
          return {
            value: { tool: "tools.unknown", input: {}, reason: "invented tool" },
            usage: { inputTokens: 10, outputTokens: 20 },
          };
        },
      };
    },
  }, tools as never);
  const result = await runtime.run({
    role: "debugger",
    task: "fix the failing workspace write",
    signal: new AbortController().signal,
  });
  const parsed = JSON.parse(prompt) as { payload: { availableTools: Array<{ name: string }> } };
  assert.deepEqual(parsed.payload.availableTools.map((item) => item.name), ["workspace.write_file"]);
  assert.equal(result.proposedAction, undefined);
});

test("ordinary chat is not eligible for coding subagent recovery", () => {
  assert.equal(isSubagentWorthyTask("สวัสดี Sofia ช่วยตอบว่า 2+2 เท่ากับเท่าไร"), false);
  assert.equal(isSubagentWorthyTask("fix the failing TypeScript build"), true);
  assert.equal(isSubagentWorthyTask("ช่วยแก้โค้ดใน repository"), true);
});
