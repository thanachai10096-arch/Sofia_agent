import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assessAction } from "../src/security/guard.js";
import { createNodeWorkspaceRuntime } from "../src/platform/local-runtime.js";
import { createBuiltinTools } from "../src/tools/builtin.js";

const blocked = [".env", ".git", "node_modules", ".sofia/secrets"];
const assess = (toolName: string, input: Record<string, unknown>) =>
  assessAction({ runId: "r", toolName, input, effects: ["write"] }, blocked, []);

test("security guard checks every apply_patch operation path", () => {
  assert.throws(() => assess("workspace.apply_patch", { operations: [{ path: ".env", content: "x", expectedContent: "" }] }), /secret|blocked/i);
  assert.throws(() => assess("workspace.apply_patch", { operations: [{ path: "src/ok.ts", content: "x" }, { path: "sub/.git/hooks/pre-commit", content: "x" }] }), /blocked/i);
  assert.doesNotThrow(() => assess("workspace.apply_patch", { operations: [{ path: "src/ok.ts", content: "x" }] }));
});

test("blocked directory names match at any depth", () => {
  assert.throws(() => assess("workspace.write_file", { path: "sub/.git/config", content: "x" }), /blocked/i);
  assert.throws(() => assess("workspace.write_file", { path: "pkg/node_modules/x.js", content: "x" }), /blocked/i);
  assert.throws(() => assess("workspace.write_file", { path: "sub\\.git\\config", content: "x" }), /blocked/i);
  assert.throws(() => assess("workspace.write_file", { path: "pkg\\node_modules\\x.js", content: "x" }), /blocked/i);
});

test("runtime refuses to overwrite secret files through apply_patch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-bypass-"));
  try {
    await writeFile(path.join(root, ".env"), "KEY=old\n");
    await mkdir(path.join(root, "sub", ".git"), { recursive: true });
    await writeFile(path.join(root, "sub", ".git", "config"), "x");
    const runtime = createNodeWorkspaceRuntime(root);
    const patch = createBuiltinTools().find((t) => t.name === "workspace.apply_patch")!;
    for (const target of [".env", "sub/.git/config"]) {
      const original = await readFile(path.join(root, target), "utf8");
      await assert.rejects(
        patch.execute({ operations: [{ path: target, content: "PWNED", expectedContent: original }] }, { runtime } as never),
        /sensitive workspace paths/i,
      );
      assert.equal(await readFile(path.join(root, target), "utf8"), original);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git runtime rejects config/alias execution flags and unknown subcommands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-git-"));
  try {
    const runtime = createNodeWorkspaceRuntime(root);
    for (const args of [
      ["-c", "alias.x=!echo RCE", "x"],
      ["-C", "..", "status"],
      ["--exec-path=/tmp", "status"],
      ["config", "alias.x", "!echo RCE"],
      ["fetch", "--upload-pack=touch /tmp/pwned", "origin"],
      ["apply", "--unsafe-paths", "patch.diff"],
      ["apply", "--unsafe-paths=true", "patch.diff"],
      [],
    ]) {
      await assert.rejects(runtime.git(args), /not allowed by Sofia runtime policy/, JSON.stringify(args));
    }
    const ok = await runtime.git(["status"]);
    assert.ok(typeof ok.code === "number");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
