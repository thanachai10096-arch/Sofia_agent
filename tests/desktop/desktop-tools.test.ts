import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDesktopTools, createDesktopPrincipal, DesktopRuntime } from "../../src/desktop/index.js";
import type { ToolContext } from "../../src/tools/types.js";

function context(): ToolContext {
  return { runtime: {} as ToolContext["runtime"] };
}

test("desktop tool adapter exposes only the capabilities granted to its host principal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-desktop-tools-"));
  try {
    await writeFile(path.join(root, "hello.txt"), "hello");
    const runtime = new DesktopRuntime({ workspaceRoot: root });
    const readerTools = createDesktopTools({
      runtime,
      principal: createDesktopPrincipal("reader", ["workspace:read", "workspace:list"]),
    });
    const read = readerTools.find((tool) => tool.name === "desktop.workspace.read_file");
    const write = readerTools.find((tool) => tool.name === "desktop.workspace.write_file");
    assert.ok(read);
    assert.ok(write);
    assert.deepEqual(await read.execute({ path: "hello.txt" }, context()), { path: "hello.txt", content: "hello" });
    await assert.rejects(write.execute({ path: "new.txt", content: "no" }, context()), /not permitted/);
    assert.equal(readerTools.length, 5);
    assert.equal(await readFile(path.join(root, "hello.txt"), "utf8"), "hello");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop process tool passes arguments without a shell and honors allowlist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-desktop-tools-"));
  try {
    const tools = createDesktopTools({
      runtime: new DesktopRuntime({ workspaceRoot: root, allowedExecutables: ["node"] }),
      principal: createDesktopPrincipal("executor", ["process:execute"]),
    });
    const processTool = tools.find((tool) => tool.name === "desktop.process.run");
    assert.ok(processTool);
    const result = await processTool.execute({ command: "node", args: ["--version"] }, context()) as { exitCode: number; stdout: string };
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /v\d+/);
    await assert.rejects(processTool.execute({ command: "npm.cmd", args: ["--version"] }, context()), /not allowlisted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
