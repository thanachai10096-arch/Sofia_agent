import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyToolEffects,
  defaultPolicy,
  effectiveToolEffects,
  toolPermission,
  type ExecutionPolicy,
} from "./policy.js";

function policy(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return {
    ...defaultPolicy,
    blockedPaths: [...defaultPolicy.blockedPaths],
    allowedHosts: [...defaultPolicy.allowedHosts],
    permissions: { ...defaultPolicy.permissions },
    ...overrides,
  };
}

test("unknown tools are classified as destructive by default", () => {
  assert.deepEqual(classifyToolEffects("custom.unknown"), ["destructive"]);
});

test("reserved tool namespaces cannot downgrade inferred security effects", () => {
  assert.deepEqual(effectiveToolEffects("terminal.run", ["read"]), ["shell", "network", "read"]);
  assert.deepEqual(effectiveToolEffects("browser.navigate", ["read"]), ["browser", "network", "read"]);
  assert.deepEqual(effectiveToolEffects("workspace.write_file", ["read"]), ["write", "read"]);
});

test("per-tool allow override cannot bypass global shell/network/write/destructive controls", () => {
  const permissions = {
    "terminal.run": { allow: true },
    "browser.navigate": { allow: true },
    "workspace.write_file": { allow: true },
    "desktop.input.click": { allow: true },
  };
  const current = policy({ permissions });

  assert.equal(toolPermission(current, "terminal.run", ["shell", "network"]).allow, false);
  assert.equal(toolPermission(current, "browser.navigate", ["browser", "network"]).allow, false);
  assert.equal(toolPermission(current, "workspace.write_file", ["write"]).allow, false);
  assert.equal(toolPermission(current, "desktop.input.click", ["destructive"]).allow, false);
});

test("explicit per-tool denial remains authoritative even when global policy permits the effect", () => {
  const current = policy({
    allowShell: true,
    permissions: { "terminal.run": { allow: false } },
  });

  assert.equal(toolPermission(current, "terminal.run", ["shell"]).allow, false);
});
