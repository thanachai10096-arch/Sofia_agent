import assert from "node:assert/strict";
import test from "node:test";
import { sandboxCommand } from "./sandbox.js";

test("sandboxCommand rejects requests that expect unavailable network isolation", async () => {
  await assert.rejects(
    () => sandboxCommand({
      workspaceRoot: process.cwd(),
      command: "node",
      args: ["-e", "process.exit(0)"],
      network: false,
    }),
    /Network isolation is not provided/,
  );
});

test("sandboxCommand bounds captured stdout when a child emits excessive output", async () => {
  const result = await sandboxCommand({
    workspaceRoot: process.cwd(),
    command: "node",
    args: ["-e", "process.stdout.write('x'.repeat(3_000_000))"],
    timeoutMs: 5_000,
    network: true,
  });

  assert.ok(result.stdout.length <= 2_000_000);
  assert.ok(result.stderr.length <= 2_000_000);
});

test("sandboxCommand rejects command paths that attempt traversal", async () => {
  await assert.rejects(
    () => sandboxCommand({
      workspaceRoot: process.cwd(),
      command: "../node",
      network: true,
    }),
    /Unsafe sandbox command/,
  );
});
