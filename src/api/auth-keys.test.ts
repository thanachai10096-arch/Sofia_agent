import assert from "node:assert/strict";
import test from "node:test";
import { loadApiKeyScopes } from "./auth-keys.js";

test("API key registry preserves primary scopes and registers distinct scoped keys", () => {
  const keys = loadApiKeyScopes(
    "primary-key",
    ["agent:run", "agent:read"],
    JSON.stringify({
      "telegram-user-one": ["agent:run", "agent:read"],
      "telegram-user-two": ["agent:run"],
    }),
  );
  assert.deepEqual(keys["primary-key"], ["agent:run", "agent:read"]);
  assert.deepEqual(keys["telegram-user-one"], ["agent:run", "agent:read"]);
  assert.deepEqual(keys["telegram-user-two"], ["agent:run"]);
});

test("API key registry rejects malformed, duplicate, and unscoped additional keys", () => {
  assert.throws(() => loadApiKeyScopes("primary", [], "not-json"), /valid JSON object/);
  assert.throws(() => loadApiKeyScopes("primary", [], "[]"), /valid JSON object/);
  assert.throws(() => loadApiKeyScopes("primary", [], '{"primary":["agent:run"]}'), /invalid or duplicate/);
  assert.throws(() => loadApiKeyScopes("primary", [], '{"extra":[]}'), /bounded list/);
  assert.throws(() => loadApiKeyScopes("primary", [], '{"extra":["agent:run",3]}'), /bounded list/);
  assert.throws(() => loadApiKeyScopes(" ", [], undefined), /non-empty trimmed key/);
});
