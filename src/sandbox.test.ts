import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContainerSandbox, ProcessSandbox, type SandboxLimits } from "./sandbox.js";

function limits(overrides: Partial<SandboxLimits> = {}): SandboxLimits {
  return {
    timeoutMs: 2_000,
    maxOutputBytes: 16_384,
    allowNetwork: true,
    workspaceRoot: process.cwd(),
    ...overrides,
  };
}

test("ProcessSandbox fails closed when network isolation is requested", async () => {
  const sandbox = new ProcessSandbox();
  await assert.rejects(
    () => sandbox.run(process.execPath, ["-e", "process.exit(0)"], limits({ allowNetwork: false })),
    /Network isolation is not provided/,
  );
});

test("ProcessSandbox terminates a child that exceeds the combined output byte limit", async () => {
  const sandbox = new ProcessSandbox();
  await assert.rejects(
    () => sandbox.run(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(1000000))"],
      limits({ maxOutputBytes: 1024 }),
    ),
    /output exceeded the configured byte limit/,
  );
});

test("ProcessSandbox rejects timed-out commands instead of reporting success", async () => {
  const sandbox = new ProcessSandbox();
  await assert.rejects(
    () => sandbox.run(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      limits({ timeoutMs: 50 }),
    ),
    /execution timed out/,
  );
});

test("ProcessSandbox terminates and rejects aborted commands", async () => {
  const sandbox = new ProcessSandbox();
  const controller = new AbortController();
  const pending = sandbox.run(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    limits(),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending, /execution was aborted/);
});

test("ProcessSandbox rejects invalid resource limits", async () => {
  const sandbox = new ProcessSandbox();
  await assert.rejects(
    () => sandbox.run(process.execPath, ["-e", "process.exit(0)"], limits({ maxOutputBytes: 0 })),
    /maxOutputBytes must be a positive finite number/,
  );
});


test("ContainerSandbox constructs a restrictive Docker command and disables networking on request", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "sofia-container-sandbox-"));
  let capturedArgs: string[] = [];
  let capturedOptions: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal } | undefined;
  const sandbox = new ContainerSandbox({
    image: "registry.example/sofia-runner@sha256:" + "a".repeat(64),
    runner: async (args, options) => {
      capturedArgs = args;
      capturedOptions = options;
      return { stdout: "ok", stderr: "", code: 0 };
    },
  });
  try {
    const result = await sandbox.run("node", ["-e", "process.stdout.write('ok')"], limits({
      workspaceRoot,
      allowNetwork: false,
      timeoutMs: 1234,
      maxOutputBytes: 4096,
    }));
    assert.deepEqual(result, { stdout: "ok", stderr: "", code: 0 });
    assert.equal(capturedArgs[0], "run");
    assert.ok(capturedArgs.includes("--pull=never"));
    assert.ok(capturedArgs.includes("--read-only"));
    assert.ok(capturedArgs.includes("--cap-drop=ALL"));
    assert.ok(capturedArgs.includes("--security-opt=no-new-privileges"));
    assert.ok(capturedArgs.includes("--pids-limit=128"));
    assert.ok(capturedArgs.includes("--memory=512m"));
    assert.ok(capturedArgs.includes("--cpus=1"));
    assert.ok(capturedArgs.includes("none"));
    assert.ok(capturedArgs.some((arg) => arg.startsWith("type=bind,source=") && arg.endsWith(",target=/workspace,rw")));
    assert.ok(capturedArgs.includes("registry.example/sofia-runner@sha256:" + "a".repeat(64)));
    assert.deepEqual(capturedArgs.slice(-3), ["node", "-e", "process.stdout.write('ok')"]);
    assert.equal(capturedOptions?.timeoutMs, 1234);
    assert.equal(capturedOptions?.maxOutputBytes, 4096);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ContainerSandbox requires a digest-pinned image and never silently pulls images", async () => {
  assert.throws(
    () => new ContainerSandbox({ image: "node:24" }),
    /pinned by an immutable sha256 digest/,
  );
  let args: string[] = [];
  const sandbox = new ContainerSandbox({
    image: "registry.example/sofia-runner@sha256:" + "b".repeat(64),
    runner: async (captured) => {
      args = captured;
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "sofia-container-sandbox-"));
  try {
    await sandbox.run("true", [], limits({ workspaceRoot, allowNetwork: true }));
    assert.ok(args.includes("--pull=never"));
    const networkIndex = args.indexOf("--network");
    assert.equal(args[networkIndex + 1], "bridge");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
