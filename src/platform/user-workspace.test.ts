import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
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
