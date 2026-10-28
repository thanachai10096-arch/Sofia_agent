import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertSafeGitArgs, createNodeWorkspaceRuntime } from "../src/platform/local-runtime.js";

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

test("workspace search skips secret-named files", async () => {
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

test("workspace commands enforce timeout and preserve exit status", async () => {
  const f = await fixture();
  try {
    const timedOut = await f.runtime.run(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], { timeoutMs: 100 });
    assert.equal(timedOut.code, 124);
    const failed = await f.runtime.run(process.execPath, ["-e", "process.exit(7)"]);
    assert.equal(failed.code, 7);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});


test("workspace runtime blocks sensitive paths at every depth for reads and writes", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.root, "sub", ".git", "hooks"), { recursive: true });
    await writeFile(path.join(f.root, "sub", ".git", "config"), "secret");
    await assert.rejects(f.runtime.readFile("sub/.git/config"), /sensitive workspace paths/);
    await assert.rejects(f.runtime.writeFile("sub/.git/hooks/pre-commit", "malicious"), /sensitive workspace paths/);
    await assert.rejects(f.runtime.writeFile(".env", "API_KEY=secret"), /sensitive workspace paths/);
    await assert.rejects(f.runtime.readFile("nested/.env.production"), /sensitive workspace paths/);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});


test("Docker sandbox mode fails closed without an explicitly pinned image", async () => {
  const f = await fixture();
  const oldMode = process.env.SOFIA_SANDBOX_MODE;
  const oldImage = process.env.SOFIA_SANDBOX_IMAGE;
  process.env.SOFIA_SANDBOX_MODE = "docker";
  delete process.env.SOFIA_SANDBOX_IMAGE;
  try {
    const result = await f.runtime.run(process.execPath, ["-e", "process.exit(0)"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /SOFIA_SANDBOX_IMAGE must name a preloaded SHA-256-pinned container image/);
  } finally {
    if (oldMode === undefined) delete process.env.SOFIA_SANDBOX_MODE;
    else process.env.SOFIA_SANDBOX_MODE = oldMode;
    if (oldImage === undefined) delete process.env.SOFIA_SANDBOX_IMAGE;
    else process.env.SOFIA_SANDBOX_IMAGE = oldImage;
    await rm(f.parent, { recursive: true, force: true });
  }
});


test("Git runtime blocks destructive history and working-tree operations", () => {
  assert.doesNotThrow(() => assertSafeGitArgs(["status", "--short"]));
  assert.doesNotThrow(() => assertSafeGitArgs(["restore", "--staged", "src/file.ts"]));
  assert.throws(() => assertSafeGitArgs(["reset", "--hard", "HEAD"]), /subcommand is not allowed/);
  assert.throws(() => assertSafeGitArgs(["clean", "-fd"]), /subcommand is not allowed/);
  assert.throws(() => assertSafeGitArgs(["rebase", "main"]), /subcommand is not allowed/);
  assert.throws(() => assertSafeGitArgs(["checkout", "--", "src/file.ts"]), /subcommand is not allowed/);
  assert.throws(() => assertSafeGitArgs(["restore", "src/file.ts"]), /working tree is blocked/);
  assert.throws(() => assertSafeGitArgs(["restore", "--staged", "--worktree", "src/file.ts"]), /working tree is blocked/);
});

test("Git runtime blocks force pushes and Git execution/configuration overrides", () => {
  assert.doesNotThrow(() => assertSafeGitArgs(["push", "origin", "feature-branch"]));
  assert.throws(() => assertSafeGitArgs(["push", "--force", "origin", "feature-branch"]), /Destructive or force Git options/);
  assert.throws(() => assertSafeGitArgs(["push", "--force-with-lease", "origin", "feature-branch"]), /Destructive or force Git options/);
  assert.throws(() => assertSafeGitArgs(["status", "-c", "core.pager=cat"]), /Git option is not allowed/);
  assert.throws(() => assertSafeGitArgs(["status", "--git-dir=/tmp/other.git"]), /Git option is not allowed/);
});
