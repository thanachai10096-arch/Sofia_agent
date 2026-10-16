import assert from "node:assert/strict";
import test from "node:test";
import { createBuiltinTools } from "./builtin.js";
import type { WorkspaceRuntime } from "../platform/runtime.js";

function runtimeWith(stdout: string, code = 0): WorkspaceRuntime {
  return {
    platform: "linux",
    async cwd() { return "/workspace"; },
    async readFile() { return ""; },
    async writeFile() {},
    async listFiles() { return []; },
    async search() { return []; },
    async run() { return { stdout, stderr: "", code }; },
    async git() { return { stdout: "", stderr: "", code: 0 }; },
  };
}

const tap = [
  "TAP version 13",
  "1..2",
  "ok 1 - first",
  "ok 2 - second",
  "# tests 2",
  "# pass 2",
  "# fail 0",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 4.2",
].join("\n");

test("project.verify returns structured TAP counts only from a complete test summary", async () => {
  const tool = createBuiltinTools().find((item) => item.name === "project.verify");
  assert.ok(tool);
  const result = await tool.execute({ kind: "test" }, { runtime: runtimeWith(tap) }) as Record<string, unknown>;
  assert.equal(result.passed, true);
  assert.equal(result.testsTotal, 2);
  assert.equal(result.passedTests, 2);
  assert.equal(result.failedTests, 0);
  assert.equal(result.skippedTests, 0);
  assert.equal(result.cancelledTests, 0);
  assert.equal(result.todoTests, 0);
});

test("project.verify never fabricates TAP metrics when the summary is absent or the command fails", async () => {
  const tool = createBuiltinTools().find((item) => item.name === "project.verify");
  assert.ok(tool);
  const missing = await tool.execute({ kind: "test" }, { runtime: runtimeWith("all tests passed") }) as Record<string, unknown>;
  assert.equal(missing.passed, true);
  assert.equal(missing.testsTotal, undefined);

  const failed = await tool.execute({ kind: "test" }, { runtime: runtimeWith(tap, 1) }) as Record<string, unknown>;
  assert.equal(failed.passed, false);
  assert.equal(failed.testsTotal, 2);
});
