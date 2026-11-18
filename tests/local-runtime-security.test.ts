import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createNodeWorkspaceRuntime } from "../src/platform/local-runtime.js";

async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sofia-runtime-security-"));
  const root = path.join(parent, "workspace");
  await mkdir(root);
  return { parent, root, runtime: createNodeWorkspaceRuntime(root) };
}


test("workspace commands do not inherit runtime code-injection environment variables", async () => {
  const f = await fixture();
  const names = ["NODE_OPTIONS", "NODE_PATH", "PYTHONPATH"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.NODE_OPTIONS = "--trace-warnings";
    process.env.NODE_PATH = "/tmp/untrusted-node-modules";
    process.env.PYTHONPATH = "/tmp/untrusted-python";
    const result = await f.runtime.run(process.execPath, [
      "-e",
      "process.stdout.write(JSON.stringify({nodeOptions:process.env.NODE_OPTIONS ?? null,nodePath:process.env.NODE_PATH ?? null,pythonPath:process.env.PYTHONPATH ?? null}))",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      nodeOptions: null,
      nodePath: null,
      pythonPath: null,
    });
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(f.parent, { recursive: true, force: true });
  }
});


test("Docker sandbox mode never falls back to host Git when its pinned image is missing", async () => {
  const f = await fixture();
  const oldMode = process.env.SOFIA_SANDBOX_MODE;
  const oldImage = process.env.SOFIA_SANDBOX_IMAGE;
  process.env.SOFIA_SANDBOX_MODE = "docker";
  delete process.env.SOFIA_SANDBOX_IMAGE;
  try {
    const result = await f.runtime.git(["status"]);
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


test("Git subprocess ignores inherited Git execution and repository override variables", async () => {
  const f = await fixture();
  const marker = path.join(f.parent, "hostile-helper-ran");
  const helper = path.join(f.parent, "hostile-git-helper.sh");
  const rogueGitDir = path.join(f.parent, "rogue.git");
  const names = [
    "GIT_DIR", "GIT_WORK_TREE", "GIT_EXTERNAL_DIFF", "GIT_SSH_COMMAND", "GIT_SSH",
    "GIT_SSH_VARIANT", "GIT_PROXY_COMMAND", "GIT_SSL_NO_VERIFY", "GIT_EXEC_PATH",
    "GIT_CONFIG_PARAMETERS", "GIT_ASKPASS", "GIT_PAGER", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1",
    "GIT_CONFIG_KEY_2", "GIT_CONFIG_VALUE_2",
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: f.root });
    await writeFile(path.join(f.root, "visible.txt"), "visible");
    execFileSync("git", ["init", "--bare", "--quiet", rogueGitDir], { cwd: f.parent });
    await writeFile(helper, "#!/bin/sh\ntouch " + JSON.stringify(marker) + "\nexit 1\n");
    await chmod(helper, 0o755);

    process.env.GIT_DIR = rogueGitDir;
    process.env.GIT_WORK_TREE = f.parent;
    process.env.GIT_EXTERNAL_DIFF = helper;
    process.env.GIT_SSH_COMMAND = helper;
    process.env.GIT_SSH = helper;
    process.env.GIT_SSH_VARIANT = "simple";
    process.env.GIT_PROXY_COMMAND = helper;
    process.env.GIT_SSL_NO_VERIFY = "1";
    process.env.GIT_EXEC_PATH = f.parent;
    process.env.GIT_CONFIG_PARAMETERS = "'diff.external=" + helper + "'";
    process.env.GIT_ASKPASS = helper;
    process.env.GIT_PAGER = helper;
    process.env.GIT_CONFIG_COUNT = "3";
    process.env.GIT_CONFIG_KEY_0 = "core.sshCommand";
    process.env.GIT_CONFIG_VALUE_0 = helper;
    process.env.GIT_CONFIG_KEY_1 = "diff.external";
    process.env.GIT_CONFIG_VALUE_1 = helper;
    process.env.GIT_CONFIG_KEY_2 = "core.hooksPath";
    process.env.GIT_CONFIG_VALUE_2 = f.parent;

    const status = await f.runtime.git(["status", "--short"]);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /visible\.txt/, "Git must stay rooted in the configured workspace");

    const nullFile = process.platform === "win32" ? "NUL" : "/dev/null";
    await f.runtime.git(["diff", "--no-index", nullFile, "visible.txt"]);
    await assert.rejects(
      async () => import("node:fs/promises").then(({ access }) => access(marker)),
      /ENOENT/,
      "host-provided external diff helper must not execute",
    );
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(f.parent, { recursive: true, force: true });
  }
});
