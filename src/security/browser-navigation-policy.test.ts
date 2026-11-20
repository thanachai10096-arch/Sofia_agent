import assert from "node:assert/strict";
import test from "node:test";
import { defaultPolicy, effectiveToolEffects, toolPermission } from "./policy.js";

test("browser.navigate is a network read, not a privileged page interaction", () => {
  const effects = effectiveToolEffects("browser.navigate");
  assert.deepEqual(effects, ["network", "read"]);

  const networkDisabled = { ...defaultPolicy, allowBrowser: true, allowNetwork: false };
  assert.equal(toolPermission(networkDisabled, "browser.navigate", effects).allow, false);

  const networkEnabled = { ...defaultPolicy, allowBrowser: false, allowNetwork: true };
  assert.notEqual(toolPermission(networkEnabled, "browser.navigate", effects).allow, false);
});

test("browser page interaction remains separately gated from navigation", () => {
  const effects = effectiveToolEffects("browser.click");
  assert.deepEqual(effects, ["browser", "network"]);

  const networkOnly = { ...defaultPolicy, allowNetwork: true, allowBrowser: false };
  assert.equal(toolPermission(networkOnly, "browser.click", effects).allow, false);

  const browserAndNetwork = { ...defaultPolicy, allowNetwork: true, allowBrowser: true };
  assert.notEqual(toolPermission(browserAndNetwork, "browser.click", effects).allow, false);
});
