import assert from "node:assert/strict";
import test from "node:test";
import { resolveApiScopes } from "./scopes.js";

test("default API scopes do not grant approval authority", () => {
  const scopes = resolveApiScopes(undefined);
  assert.deepEqual(scopes, ["agent:run", "agent:read"]);
  assert.equal(scopes.includes("approval:read"), false);
  assert.equal(scopes.includes("approval:decide"), false);
});

test("approval scopes are granted only when explicitly configured", () => {
  assert.deepEqual(
    resolveApiScopes("agent:run, approval:read,approval:decide"),
    ["agent:run", "approval:read", "approval:decide"],
  );
});

test("an explicitly empty scope configuration grants no permissions", () => {
  assert.deepEqual(resolveApiScopes(""), []);
});

test("scope parsing trims entries and drops empty entries", () => {
  assert.deepEqual(resolveApiScopes(" agent:run, , agent:read ,, "), ["agent:run", "agent:read"]);
});
