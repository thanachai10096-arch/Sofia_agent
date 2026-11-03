import assert from "node:assert/strict";
import test from "node:test";
import { parseMessagingApiScopes } from "./messaging-scopes.js";

test("messaging credentials default to least-privilege agent scopes", () => {
  assert.deepEqual(parseMessagingApiScopes(undefined), ["agent:run", "agent:read"]);
  assert.deepEqual(parseMessagingApiScopes("  "), ["agent:run", "agent:read"]);
});

test("messaging scopes can explicitly grant isolated personal memory access", () => {
  assert.deepEqual(
    parseMessagingApiScopes("agent:run,agent:read,memory:read,memory:write"),
    ["agent:run", "agent:read", "memory:read", "memory:write"],
  );
});

test("messaging scopes reject admin, desktop, unknown, empty, and duplicate scopes", () => {
  for (const value of [
    "security:admin",
    "agent:run,security:admin",
    "desktop:process:execute",
    "unknown:scope",
    "agent:run,,agent:read",
    "agent:run,agent:run",
  ]) {
    assert.throws(() => parseMessagingApiScopes(value), /SOFIA_MESSAGING_API_SCOPES/);
  }
});
