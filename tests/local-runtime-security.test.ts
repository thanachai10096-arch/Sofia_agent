import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNodeWorkspaceRuntime } from "../src/platform/local-runtime.js";

async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sofia-runtime-security-"));
  const root = path.join(parent, "workspace");
  await mkdir(root);
  return { parent, root, runtime: createNodeWorkspaceRuntime(root) };
}

test("workspace runtime rejects lexical path traversal", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.runtime.readFile("../outside.txt"), /escapes the configured root/);
    await assert.rejects(f.runtime.writeFile("../outside.txt", "nope"), /escapes the configured root/);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("workspace runtime rejects symlinks that resolve outside the workspace", async (t) => {
  const f = await fixture();
  try {
    const outside = path.join(f.parent, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "private");
    try {
      await symlink(outside, path.join(f.root, "escape"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      t.skip("symlink creation is unavailable in this environment");
      return;
    }
    await assert.rejects(f.runtime.readFile("escape/secret.txt"), /escapes the configured root/);
    await assert.rejects(f.runtime.listFiles("escape"), /escapes the configured root/);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("workspace search skips secret-named files and symlinks", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, "app.ts"), "const marker = 'visible';");
    await writeFile(path.join(f.root, ".env"), "marker=hidden");
    await writeFile(path.join(f.root, "credentials.json"), '{"marker":"hidden"}');
    const matches = await f.runtime.search("marker");
    assert.equal(matches.length, 1);
    assert.match(matches[0] ?? "", /app\.ts/);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("workspace commands enforce timeout and preserve the exit status", async () => {
  const f = await fixture();
  try {
    const result = await f.runtime.run(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], { timeoutMs: 100 });
    assert.equal(result.code, 124);
    const failed = await f.runtime.run(process.execPath, ["-e", "process.exit(7)"]);
    assert.equal(failed.code, 7);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});
