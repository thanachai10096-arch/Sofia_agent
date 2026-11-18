import assert from "node:assert/strict";
import test from "node:test";
import { defaultPolicy, effectiveToolEffects, toolPermission } from "./policy.js";

test("sandbox execution is a distinct host-controlled capability", () => {
  const effects = effectiveToolEffects("sandbox.exec", ["sandbox"]);
  assert.deepEqual(effects, ["sandbox"]);
  assert.equal(toolPermission({ ...defaultPolicy, allowSandbox: true }, "sandbox.exec", effects).allow, undefined);
  assert.equal(toolPermission({ ...defaultPolicy, allowSandbox: false }, "sandbox.exec", effects).allow, false);
  assert.equal(toolPermission({ ...defaultPolicy, allowSandbox: true, allowShell: false }, "sandbox.exec", effects).allow, undefined);
});
