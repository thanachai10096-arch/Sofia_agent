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
    closeBrowserProfiles: async () => onClose(),
  };
}

test("tenant dependency registry caches one bundle per issued tenant and closes each bundle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-tenant-registry-"));
  let factoryCalls = 0;
  let closeCalls = 0;
  const resolver = createTenantResourceResolver(root);
  const registry = new TenantDependencyRegistry(resolver, () => {
    factoryCalls += 1;
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
