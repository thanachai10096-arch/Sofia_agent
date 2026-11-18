import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTenantResourceResolver } from "./tenant-resolver.js";

test("resolver issues immutable contexts with isolated principal workspaces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-tenant-resolver-"));
  try {
    const resolver = createTenantResourceResolver(root);
    const first = await resolver.resolve("principal-a");
    const second = await resolver.resolve("principal-b");

    resolver.assertContext(first);
    resolver.assertContext(second);
    assert.notEqual(first.tenantId, second.tenantId);
    assert.notEqual(first.workspaceRoot, second.workspaceRoot);
    assert.equal(Object.isFrozen(first), true);
    assert.throws(() => {
      (first as { workspaceRoot: string }).workspaceRoot = root;
    }, TypeError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolver rejects forged and foreign contexts", async () => {
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), "sofia-tenant-resolver-a-"));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), "sofia-tenant-resolver-b-"));
  try {
    const firstResolver = createTenantResourceResolver(firstRoot);
    const secondResolver = createTenantResourceResolver(secondRoot);
    const context = await firstResolver.resolve("principal-a");

    assert.throws(() => firstResolver.assertContext({
      tenantId: context.tenantId,
      principalId: context.principalId,
      workspaceRoot: context.workspaceRoot,
    }), /untrusted|foreign/i);
    assert.throws(() => secondResolver.assertContext(context), /untrusted|foreign/i);
  } finally {
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
  }
});

test("resolver rejects non-absolute tenant roots", () => {
  assert.throws(() => createTenantResourceResolver("relative"), /absolute path/i);
});
