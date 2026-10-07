import test from "node:test";
import assert from "node:assert/strict";
import { buildRepositoryMap } from "./repository-intelligence.js";
import type { WorkspaceRuntime } from "../platform/runtime.js";

test("repository intelligence builds files, symbols, dependencies and task relevance", async () => {
  const files: Record<string,string> = {
    "src/auth/login.ts": 'export function login() { return userService(); }\nimport { userService } from "../user/service";',
    "src/user/service.ts": "export function userService() { return true; }",
    "src/auth/login.test.ts": "test login",
    "package.json": "{}",
  };
  const runtime = {
    cwd: async () => "/workspace",
    listFiles: async () => Object.keys(files),
    readFile: async (path: string) => files[path] ?? "",
  } as unknown as WorkspaceRuntime;

  const map = await buildRepositoryMap(runtime, "fix login authentication");
  assert.equal(map.files.length, 4);
  assert.ok(map.symbols.some((symbol) => symbol.name === "login"));
  assert.ok(map.dependencies.some((edge) => edge.from === "src/auth/login.ts"));
  assert.ok(map.relevantFiles.includes("src/auth/login.ts"));
  assert.ok(map.testMappings.some((item) => item.testPath === "src/auth/login.test.ts" && item.sourcePath === "src/auth/login.ts"));
  assert.ok(map.impactRanking.some((item) => item.path === "src/auth/login.ts"));
  assert.ok(map.symbolReferences.some((item) => item.path === "src/auth/login.ts" && item.symbol === "login"));
});
