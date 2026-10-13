import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { DesktopPermissionError, DesktopRuntime, createDesktopPrincipal } from "../../src/desktop/index.js";

const all = ["system:discover", "workspace:list", "workspace:read", "workspace:write", "process:execute"] as const;

test("desktop runtime limits file operations to configured workspace", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sofia-desktop-"));
  const root = path.join(temp, "workspace");
  await mkdir(root);
  await writeFile(path.join(root, "hello.txt"), "hello");
  const runtime = new DesktopRuntime({ workspaceRoot: root });
  const principal = createDesktopPrincipal("test", [...all]);
  try {
    assert.equal(await runtime.readTextFile(principal, "hello.txt"), "hello");
    assert.deepEqual((await runtime.listFiles(principal)).map((entry) => entry.name), ["hello.txt"]);
    await runtime.writeTextFile(principal, "nested/new.txt", "new");
    assert.equal(await readFile(path.join(root, "nested/new.txt"), "utf8"), "new");
    await assert.rejects(runtime.readTextFile(principal, "../outside.txt"), DesktopPermissionError);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("desktop runtime requires capabilities and blocks symlink escapes", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sofia-desktop-"));
  const root = path.join(temp, "workspace");
  const outside = path.join(temp, "secret.txt");
  await mkdir(root);
  await writeFile(outside, "secret");
  await symlink(outside, path.join(root, "secret-link.txt"));
  const runtime = new DesktopRuntime({ workspaceRoot: root });
  try {
    const reader = createDesktopPrincipal("reader", ["workspace:read"]);
    await assert.rejects(runtime.listFiles(reader), DesktopPermissionError);
    await assert.rejects(runtime.readTextFile(reader, "secret-link.txt"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("process execution is disabled unless an executable is explicitly allowlisted", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sofia-desktop-"));
  const runtime = new DesktopRuntime({ workspaceRoot: temp });
  const principal = createDesktopPrincipal("executor", ["process:execute"]);
  try {
    await assert.rejects(runtime.runCommand(principal, "node", ["--version"]), /not allowlisted/);
    const enabled = new DesktopRuntime({ workspaceRoot: temp, allowedExecutables: ["node"] });
    const result = await enabled.runCommand(principal, "node", ["--version"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /v\d+/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


test("desktop child processes receive only baseline and explicitly allowed environment variables", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sofia-desktop-env-"));
  const names = ["SOFIA_TEST_SECRET", "SOFIA_TEST_ALLOWED_VALUE", "NODE_OPTIONS"] as const;
  const original = new Map(names.map((name) => [name, process.env[name]]));
  process.env.SOFIA_TEST_SECRET = "must-not-leak";
  process.env.SOFIA_TEST_ALLOWED_VALUE = "explicitly-allowed";
  process.env.NODE_OPTIONS = "--require=sofia-test-injection";
  const runtime = new DesktopRuntime({
    workspaceRoot: temp,
    allowedExecutables: ["node"],
    allowedEnvironmentVariables: ["SOFIA_TEST_ALLOWED_VALUE", "NODE_OPTIONS"],
  });
  const principal = createDesktopPrincipal("executor", ["process:execute"]);
  try {
    const script = "process.stdout.write(JSON.stringify({secret:process.env.SOFIA_TEST_SECRET??null,allowed:process.env.SOFIA_TEST_ALLOWED_VALUE??null,nodeOptions:process.env.NODE_OPTIONS??null,path:!!process.env.PATH}))";
    const result = await runtime.runCommand(principal, "node", ["-e", script]);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      secret: null,
      allowed: "explicitly-allowed",
      nodeOptions: null,
      path: true,
    });
  } finally {
    for (const name of names) {
      const value = original.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(temp, { recursive: true, force: true });
  }
});
