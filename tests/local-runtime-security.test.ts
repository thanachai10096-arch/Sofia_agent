import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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
