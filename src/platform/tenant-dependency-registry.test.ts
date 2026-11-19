import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTenantResourceResolver } from "./tenant-resolver.js";
import { TenantDependencyRegistry } from "./tenant-dependency-registry.js";
import type { AgentDependencies } from "../agent/types.js";

function dependencies(onClose: () => void): AgentDependencies {
  return {
    provider: { generate: async () => ({ text: "ok" }) },
    router: { select: () => { throw new Error("unused"); }, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
    close: async () => onClose(),
  };
}

test("tenant dependency registry caches one bundle per issued tenant and closes each bundle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-tenant-registry-"));
  let factoryCalls = 0;
  let closeCalls = 0;
  const resolver = createTenantResourceResolver(root);
  const registry = new TenantDependencyRegistry(resolver, async () => {
    factoryCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return dependencies(() => { closeCalls += 1; });
  });

  try {
    const [firstA, secondA, firstB] = await Promise.all([
      registry.getForPrincipal("principal-a"),
      registry.getForPrincipal("principal-a"),
      registry.getForPrincipal("principal-b"),
    ]);
    assert.equal(firstA, secondA);
    assert.notEqual(firstA, firstB);
    assert.equal(factoryCalls, 2);
    await registry.close();
    assert.equal(closeCalls, 2);
    await assert.rejects(registry.getForPrincipal("principal-a"), /registry is closed/);
  } finally {
    await registry.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("tenant dependency registry rejects forged contexts before invoking the factory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-tenant-registry-forged-"));
  let factoryCalls = 0;
  const resolver = createTenantResourceResolver(root);
  const registry = new TenantDependencyRegistry(resolver, () => {
    factoryCalls += 1;
    return dependencies(() => undefined);
  });

  try {
    await assert.rejects(
      registry.get({
        tenantId: "forged",
        principalId: "principal-a",
        workspaceRoot: path.join(root, "other"),
      }),
      /Untrusted or foreign tenant context/,
    );
    assert.equal(factoryCalls, 0);
  } finally {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("tenant dependency registry evicts failed construction so a later request can retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-tenant-registry-retry-"));
  let factoryCalls = 0;
  const resolver = createTenantResourceResolver(root);
  const registry = new TenantDependencyRegistry(resolver, () => {
    factoryCalls += 1;
    if (factoryCalls === 1) throw new Error("temporary construction failure");
    return dependencies(() => undefined);
  });

  try {
    await assert.rejects(registry.getForPrincipal("principal-a"), /temporary construction failure/);
    const recovered = await registry.getForPrincipal("principal-a");
    assert.ok(recovered);
    assert.equal(factoryCalls, 2);
  } finally {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
});


test("tenant dependency registry waits for in-flight construction before closing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-tenant-registry-close-"));
  const resolver = createTenantResourceResolver(root);
  let release!: () => void;
  let closeCalls = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const registry = new TenantDependencyRegistry(resolver, async () => {
    await gate;
    return dependencies(() => { closeCalls += 1; });
  });

  try {
    const context = await resolver.resolve("principal-a");
    const pending = registry.get(context);
    const closing = registry.close();
    release();
    const [resolved] = await Promise.all([pending, closing]);
    assert.ok(resolved);
    assert.equal(closeCalls, 1);
    assert.throws(() => registry.get(context), /registry is closed/);
  } finally {
    release();
    await registry.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent tenant dependency registry close calls share the same shutdown", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-tenant-registry-concurrent-close-"));
  const resolver = createTenantResourceResolver(root);
  let release!: () => void;
  let closeCalls = 0;
  let cleanupFinished = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const registry = new TenantDependencyRegistry(resolver, () => dependencies(async () => {
    closeCalls += 1;
    await gate;
    cleanupFinished = true;
  }));

  try {
    await registry.getForPrincipal("principal-a");
    const firstClose = registry.close();
    const secondClose = registry.close();
    assert.equal(firstClose, secondClose);
    await Promise.resolve();
    assert.equal(closeCalls, 1);
    assert.equal(cleanupFinished, false);
    release();
    await Promise.all([firstClose, secondClose]);
    assert.equal(cleanupFinished, true);
    assert.equal(closeCalls, 1);
  } finally {
    release();
    await registry.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
