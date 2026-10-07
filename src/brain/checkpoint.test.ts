import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeCheckpointManager } from "./checkpoint.js";

test("restores dirty tracked files and removes files created after checkpoint", async () => {
  let files: Record<string, string> = {
    "src/app.ts": "original",
    "README.md": "readme",
  };
  let status = [" M src/app.ts", "?? generated.ts"];
  const runtime = {
    platform: "linux" as const,
    cwd: async () => "/workspace",
    readFile: async (path: string) => {
      if (!(path in files)) throw new Error("missing");
      return files[path]!;
    },
    writeFile: async (path: string, content: string) => { files[path] = content; },
    listFiles: async () => Object.keys(files),
    search: async () => [],
    run: async () => ({ stdout: "", stderr: "", code: 0 }),
    git: async (args: string[]) => {
      if (args[0] === "ls-files") return { stdout: "src/app.ts\nREADME.md\n", stderr: "", code: 0 };
      if (args[0] === "status") return { stdout: status.join("\n"), stderr: "", code: 0 };
      if (args[0] === "rev-parse") return { stdout: "abc\n", stderr: "", code: 0 };
      if (args[0] === "restore") { files["src/app.ts"] = "original"; status = []; return { stdout: "", stderr: "", code: 0 }; }
      if (args[0] === "clean") { delete files[args[args.length - 1]!]; return { stdout: "", stderr: "", code: 0 }; }
      throw new Error("unexpected git command: " + args.join(" "));
    },
  };

  const manager = new RuntimeCheckpointManager(runtime);
  const checkpoint = await manager.create(new AbortController().signal);

  files["src/app.ts"] = "changed";
  files["generated.ts"] = "new";
  status = [" M src/app.ts", "?? generated.ts"];

  const result = await manager.rollback(checkpoint.id, new AbortController().signal);
  assert.equal(files["src/app.ts"], "original");
  assert.equal("generated.ts" in files, false);
  assert.ok(result.restoredFiles.includes("src/app.ts"));
});
