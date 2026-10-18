import assert from "node:assert/strict";
import test from "node:test";
import { CoordinatedSubagentRuntime } from "./coordinated-subagent-runtime.js";
import type { SubagentRuntime } from "./subagents.js";

test("coordinated runtime preserves successful subagent results", async () => {
  const runtime: SubagentRuntime = {
    async run(request) {
      return { role: request.role, summary: "done", output: { task: request.task } };
    },
  };
  const bounded = new CoordinatedSubagentRuntime(runtime, { timeoutMs: 1000 });
  const result = await bounded.run({
    role: "explorer",
    task: "inspect repository",
    context: { safe: true },
    signal: new AbortController().signal,
  });
  assert.equal(result.summary, "done");
  assert.deepEqual(result.output, { task: "inspect repository" });
});

test("coordinated runtime surfaces timeout errors", async () => {
  const runtime: SubagentRuntime = {
    async run() {
      return new Promise((resolve) => setTimeout(() => resolve({
        role: "explorer", summary: "too late", output: null,
      }), 500));
    },
  };
  const bounded = new CoordinatedSubagentRuntime(runtime, { timeoutMs: 100 });
  await assert.rejects(
    bounded.run({ role: "explorer", task: "slow task", signal: new AbortController().signal }),
    /timed out/,
  );
});

test("coordinated runtime rejects oversized context before execution", async () => {
  let called = false;
  const runtime: SubagentRuntime = {
    async run(request) {
      called = true;
      return { role: request.role, summary: "unexpected", output: null };
    },
  };
  const bounded = new CoordinatedSubagentRuntime(runtime, { maxContextBytes: 256 });
  await assert.rejects(
    bounded.run({
      role: "explorer", task: "inspect", context: { data: "x".repeat(400) },
      signal: new AbortController().signal,
    }),
    /context exceeds configured size limit/,
  );
  assert.equal(called, false);
});
