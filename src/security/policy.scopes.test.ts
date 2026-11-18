import assert from "node:assert/strict";
import test from "node:test";
import { defaultPolicy, policyForToolScopes, toolPermission } from "./policy.js";

test("API key tool scopes grant only explicitly named elevated effects", () => {
  const policy = policyForToolScopes({
    ...defaultPolicy,
    allowFileWrite: true,
    allowShell: true,
    allowNetwork: true,
    allowBrowser: true,
    allowDestructive: true,
  }, ["tool:write", "tool:network"]);

  assert.equal(policy.allowFileWrite, true);
  assert.equal(policy.allowNetwork, true);
  assert.equal(policy.allowShell, false);
  assert.equal(policy.allowBrowser, false);
  assert.equal(policy.allowDestructive, false);
  assert.equal(toolPermission(policy, "workspace.write_file", ["write"]).allow, undefined);
  assert.equal(toolPermission(policy, "terminal.run", ["shell"]).allow, false);
});

test("API key scopes cannot override installation-wide disabled capabilities", () => {
  const policy = policyForToolScopes({
    ...defaultPolicy,
    allowFileWrite: false,
    allowShell: false,
    allowNetwork: false,
    allowBrowser: false,
    allowDestructive: false,
  }, ["tool:write", "tool:shell", "tool:network", "tool:browser", "tool:destructive"]);

  assert.equal(policy.allowFileWrite, false);
  assert.equal(policy.allowShell, false);
  assert.equal(policy.allowNetwork, false);
  assert.equal(policy.allowBrowser, false);
  assert.equal(policy.allowDestructive, false);
  assert.equal(toolPermission(policy, "workspace.write_file", ["write"]).allow, false);
  assert.equal(toolPermission(policy, "terminal.run", ["shell"]).allow, false);
});

test("API keys without elevated scopes remain read-only", () => {
  const policy = policyForToolScopes({ ...defaultPolicy, allowFileWrite: true }, []);

  assert.equal(toolPermission(policy, "workspace.read_file", ["read"]).allow, undefined);
  assert.equal(toolPermission(policy, "workspace.write_file", ["write"]).allow, false);
  assert.equal(toolPermission(policy, "terminal.run", ["shell"]).allow, false);
  assert.equal(toolPermission(policy, "browser.goto", ["network", "read"]).allow, false);
});
