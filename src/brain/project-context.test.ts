import assert from "node:assert/strict";
import test from "node:test";

import { compactProjectContext, discoverProjectContext } from "./project-context.js";

test("discovers standard project guidance without failing on missing files", async () => {
  const runtime = {
    platform: "linux" as const,
    cwd: async () => "/workspace",
    readFile: async (path: string) => {
      if (path === "SOFIA.md") return "# Rules\nUse npm test.";
      throw new Error("missing");
    },
    writeFile: async () => {},
    listFiles: async () => [],
    search: async () => [],
    run: async () => ({ stdout: "", stderr: "", code: 0 }),
    git: async () => ({ stdout: "", stderr: "", code: 0 }),
  };

  const context = await discoverProjectContext(runtime);
  assert.equal(context.root, "/workspace");
  assert.equal(context.files[0]?.path, "SOFIA.md");
  assert.match(compactProjectContext(context), /Use npm test/);
});
