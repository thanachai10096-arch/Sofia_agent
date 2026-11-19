import assert from "node:assert/strict";
import test from "node:test";
import { defaultPolicy, policyForToolScopes, type ExecutionPolicy } from "./policy.js";

function policy(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return { ...defaultPolicy, ...overrides };
}

test("API tool scopes deny elevated capabilities unless explicitly granted", () => {
  const effective = policyForToolScopes(policy(), []);
  assert.equal(effective.allowFileWrite, false);
  assert.equal(effective.allowShell, false);
  assert.equal(effective.allowNetwork, false);
  assert.equal(effective.allowBrowser, false);
  assert.equal(effective.allowDestructive, false);
  assert.equal(effective.allowTools, true);
});

test("API tool scopes grant only the named elevated capability", () => {
  const effective = policyForToolScopes(policy({
    allowFileWrite: true,
    allowShell: true,
    allowNetwork: true,
    allowBrowser: true,
    allowDestructive: true,
  }), ["tool:write"]);
  assert.equal(effective.allowFileWrite, true);
  assert.equal(effective.allowShell, false);
  assert.equal(effective.allowNetwork, false);
  assert.equal(effective.allowBrowser, false);
  assert.equal(effective.allowDestructive, false);
});

test("API tool scopes can never override installation-wide deny switches", () => {
  const effective = policyForToolScopes(policy({
    allowFileWrite: false,
    allowShell: false,
    allowNetwork: false,
    allowBrowser: false,
    allowDestructive: false,
  }), ["tool:write", "tool:shell", "tool:network", "tool:browser", "tool:destructive"]);
  assert.equal(effective.allowFileWrite, false);
  assert.equal(effective.allowShell, false);
  assert.equal(effective.allowNetwork, false);
  assert.equal(effective.allowBrowser, false);
  assert.equal(effective.allowDestructive, false);
});

test("unknown API scopes do not grant tool capabilities", () => {
  const effective = policyForToolScopes(policy({
    allowFileWrite: true,
    allowShell: true,
    allowNetwork: true,
    allowBrowser: true,
    allowDestructive: true,
  }), ["tool:root", "admin", "shell", "network"]);
  assert.equal(effective.allowFileWrite, false);
  assert.equal(effective.allowShell, false);
  assert.equal(effective.allowNetwork, false);
  assert.equal(effective.allowBrowser, false);
  assert.equal(effective.allowDestructive, false);
});
