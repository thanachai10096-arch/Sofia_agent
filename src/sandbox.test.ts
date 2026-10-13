import assert from "node:assert/strict";
import test from "node:test";
import { ProcessSandbox, type SandboxLimits } from "./sandbox.js";

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
