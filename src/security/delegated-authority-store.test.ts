import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteDelegatedAuthorityStore, createTenantAuthorityResolver } from "./delegated-authority-store.js";
import { createTenantResourceResolver } from "../platform/tenant-resolver.js";
import type { DelegatedAuthority } from "./capability-registry.js";

const grant: DelegatedAuthority = {
  principalId: "principal-a",
  scopes: ["web:read"],
  allowedCapabilityIds: ["web.search"],
  expiresAt: 9_999_999_999_999,
};

test("authority store scopes grants by tenant and principal and supports revocation", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sofia-authority-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await SqliteDelegatedAuthorityStore.open(path.join(root, "authority.sqlite"));
  t.after(() => store.close());

  store.grant("tenant-a", "principal-a", grant);
  assert.deepEqual(store.get("tenant-a", "principal-a"), grant);
  assert.equal(store.get("tenant-b", "principal-a"), undefined);
  assert.equal(store.get("tenant-a", "principal-b"), undefined);
  assert.equal(store.revoke("tenant-a", "principal-a"), true);
  assert.equal(store.get("tenant-a", "principal-a"), undefined);
  assert.equal(store.revoke("tenant-a", "principal-a"), false);
});

test("authority store rejects principal spoofing and ignores expired grants", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sofia-authority-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await SqliteDelegatedAuthorityStore.open(path.join(root, "authority.sqlite"));
  t.after(() => store.close());

  assert.throws(() => store.grant("tenant-a", "principal-b", grant), /does not match/);
  store.grant("tenant-a", "principal-a", { ...grant, expiresAt: 10 });
  assert.equal(store.get("tenant-a", "principal-a", 10), undefined);
});

test("tenant-bound authority resolver cannot read another principal's grant", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sofia-tenant-authority-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tenantResolver = createTenantResourceResolver(root);
  const context = await tenantResolver.resolve("principal-a");
  const bound = await createTenantAuthorityResolver(tenantResolver, context);
  t.after(() => bound.close());

  const store = await SqliteDelegatedAuthorityStore.open(
    path.join(context.workspaceRoot, ".sofia", "delegated-authority.sqlite"),
  );
  store.grant(context.tenantId, "principal-a", grant);
  t.after(() => store.close());

  assert.deepEqual(await bound.resolveAuthority("principal-a"), grant);
  assert.equal(await bound.resolveAuthority("principal-b"), undefined);
});
