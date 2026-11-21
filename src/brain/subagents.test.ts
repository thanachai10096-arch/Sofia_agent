import assert from "node:assert/strict";
import test from "node:test";
import { createSubagentRuntime, roleForTask, validateSubagentResult } from "./subagents.js";

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

test("subagent result validation rejects role substitution and malformed proposals", () => {
  const base = { role: "debugger", summary: "checked failure", output: { ok: true } };
  assert.equal(validateSubagentResult({ ...base, role: "security" }, "debugger"), undefined);
  assert.equal(validateSubagentResult({ ...base, proposedAction: { tool: "workspace.write_file", input: [], reason: "bad input" } }, "debugger"), undefined);
  assert.equal(validateSubagentResult({ ...base, proposedAction: { tool: "workspace.write_file", input: { path: "a" }, reason: " " } }, "debugger"), undefined);
  assert.equal(validateSubagentResult({ ...base, summary: "x".repeat(6_001) }, "debugger"), undefined);
});

test("subagent result validation returns a detached bounded proposal", () => {
  const input = { path: "hello.txt", content: "hello" };
  const raw = {
    role: "debugger",
    summary: " retry safely ",
    output: { finding: "recoverable" },
    proposedAction: { tool: "workspace.write_file", input, reason: " retry " },
  };
  const validated = validateSubagentResult(raw, "debugger");
  assert.ok(validated);
  assert.equal(validated.summary, "retry safely");
  assert.equal(validated.proposedAction?.reason, "retry");
  assert.notEqual(validated.proposedAction?.input, input);
  input.content = "mutated-after-validation";
  assert.equal(validated.proposedAction?.input.content, "hello");
});
