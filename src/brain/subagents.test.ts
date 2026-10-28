import assert from "node:assert/strict";
import test from "node:test";
import { createSubagentRuntime, roleForTask } from "./subagents.js";

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
            retries: 2,
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
