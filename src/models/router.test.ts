import assert from "node:assert/strict";
import test from "node:test";
import { ModelRouter } from "./router.js";
import type { ModelRoute } from "./types.js";

function route(overrides: Partial<ModelRoute> = {}): ModelRoute {
  return {
    id: "coding-primary",
    providerId: "provider-a",
    model: "model-a",
    capabilities: ["coding", "tool-use", "reasoning"],
    costWeight: 1,
    latencyWeight: 1,
    qualityWeight: 8,
    healthy: true,
    ...overrides,
  };
}

test("router owns a defensive copy of configured routes", () => {
  const configured = route();
  const router = new ModelRouter([configured]);

  configured.healthy = false;
  configured.capabilities.splice(0, configured.capabilities.length, "fast");

  assert.equal(router.select("coding").id, "coding-primary");
  assert.deepEqual(router.select("coding").capabilities, ["coding", "tool-use", "reasoning"]);
});

test("selected route mutations cannot change future routing decisions", () => {
  const router = new ModelRouter([route()]);
  const selected = router.select("coding");

  selected.healthy = false;
  selected.id = "attacker-controlled";
  selected.capabilities.push("vision");

  assert.equal(router.select("coding").id, "coding-primary");
  assert.deepEqual(router.listRoutes()[0]?.capabilities, ["coding", "tool-use", "reasoning"]);
});

test("preferred route is returned as a defensive copy", () => {
  const router = new ModelRouter([route(), route({
    id: "manual-route",
    capabilities: ["fast"],
    qualityWeight: 2,
  })]);

  const selected = router.select("general", "manual-route");
  selected.capabilities.push("coding");

  assert.deepEqual(router.select("general", "manual-route").capabilities, ["fast"]);
});

test("unhealthy routes are excluded and automatic routing rebuilds", () => {
  const router = new ModelRouter([
    route(),
    route({
      id: "coding-fallback",
      providerId: "provider-b",
      qualityWeight: 4,
    }),
  ]);

  router.markUnhealthy("coding-primary");

  assert.equal(router.select("coding").id, "coding-fallback");
  assert.throws(() => router.select("coding", "coding-primary"), /unhealthy/);
});

test("router fails closed when no healthy route exists", () => {
  const router = new ModelRouter([route({ healthy: false })]);

  assert.throws(() => router.select("coding"), /No healthy model route/);
  assert.throws(() => router.select("coding", "coding-primary"), /unhealthy/);
});
