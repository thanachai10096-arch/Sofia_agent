import test from "node:test";
import assert from "node:assert/strict";
import { applyEditPatch, createEditPatch, unifiedDiff } from "./edit-engine.js";
import type { WorkspaceRuntime } from "../platform/runtime.js";

test("edit engine rejects stale content", async () => {
  let content = "const value = 1;\n";
  const runtime = {
    readFile: async () => content,
    writeFile: async (_path: string, next: string) => { content = next; },
  } as unknown as WorkspaceRuntime;

  const patch = createEditPatch([{
    path: "src/value.ts",
    expectedContent: "const value = 1;\n",
    content: "const value = 2;\n",
  }]);

  content = "const value = 3;\n";
  await assert.rejects(() => applyEditPatch(runtime, patch), /Edit conflict/);
});

test("edit engine applies matching patch and reports hashes", async () => {
  let content = "hello\n";
  const runtime = {
    readFile: async () => content,
    writeFile: async (_path: string, next: string) => { content = next; },
  } as unknown as WorkspaceRuntime;

  const patch = createEditPatch([{
    path: "README.md",
    expectedContent: "hello\n",
    content: "world\n",
  }]);

  const result = await applyEditPatch(runtime, patch);
  assert.equal(result[0]?.changed, true);
  assert.equal(content, "world\n");
  assert.match(unifiedDiff("hello\n", "world\n", "README.md"), /-hello/);
  assert.match(unifiedDiff("hello\n", "world\n", "README.md"), /\+world/);
});
