import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTenantWorkspace } from "./tenant-workspace.js";

test("tenant workspaces are deterministic and isolated by principal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-tenant-test-"));
  try {
    const first = await createTenantWorkspace(root, "principal-a");
    const firstAgain = await createTenantWorkspace(root, "principal-a");
    const second = await createTenantWorkspace(root, "principal-b");
    assert.equal(first, firstAgain);
    assert.notEqual(first, second);
    assert.equal(await realpath(first), first);
    assert.equal(await realpath(second), second);
    assert.ok(first.startsWith(path.join(root, "tenants") + path.sep));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tenant workspace rejects relative roots and empty principals", async () => {
  await assert.rejects(createTenantWorkspace("relative-root", "principal-a"), /absolute path/i);
  await assert.rejects(createTenantWorkspace(os.tmpdir(), "  "), /principal ID/i);
});

test("tenant workspace rejects a tenants directory symlink escaping the root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-tenant-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "sofia-tenant-outside-"));
  try {
    await symlink(outside, path.join(root, "tenants"), "dir");
    await assert.rejects(createTenantWorkspace(root, "principal-a"), /inside the configured root/i);
    assert.deepEqual(await (await import("node:fs/promises")).readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("tenant workspace rejects a symlink at the tenant directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-tenant-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "sofia-tenant-outside-"));
  try {
    const key = (await import("node:crypto")).createHash("sha256").update("principal-a").digest("hex");
    await mkdir(path.join(root, "tenants"));
    await symlink(outside, path.join(root, "tenants", key), "dir");
    await assert.rejects(createTenantWorkspace(root, "principal-a"), /must not resolve through a symlink/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
