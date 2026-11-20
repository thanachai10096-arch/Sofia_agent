import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import { createNodeWorkspaceRuntime } from "./local-runtime.js";
import { principalWorkspacePath } from "./user-workspace.js";

test("principal workspace paths are stable, distinct, and do not expose identity", () => {
  const root = path.resolve("/tmp/sofia-user-workspaces");
  const first = principalWorkspacePath("customer-one", root);
  const second = principalWorkspacePath("customer-two", root);
  assert.equal(first, principalWorkspacePath("customer-one", root));
  assert.notEqual(first, second);
  assert.ok(first.startsWith(root + path.sep));
  assert.ok(!first.includes("customer-one"));
  assert.ok(!second.includes("customer-two"));
});

test("missing principal uses a stable local-only namespace", () => {
  const root = path.resolve("/tmp/sofia-user-workspaces");
  assert.equal(principalWorkspacePath(undefined, root), principalWorkspacePath("local-instance", root));
});


test("principal workspace runtimes cannot read another principal's files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-principal-workspaces-"));
  try {
    const firstRoot = principalWorkspacePath("api-key-owner-a", root);
    const secondRoot = principalWorkspacePath("api-key-owner-b", root);
    await mkdir(firstRoot, { recursive: true, mode: 0o700 });
    await mkdir(secondRoot, { recursive: true, mode: 0o700 });
    const first = createNodeWorkspaceRuntime(firstRoot);
    const second = createNodeWorkspaceRuntime(secondRoot);

    await first.writeFile("private-project.txt", "owner A only");
    assert.equal(await first.readFile("private-project.txt"), "owner A only");
    assert.deepEqual(await second.listFiles(), []);
    await assert.rejects(second.readFile("private-project.txt"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
