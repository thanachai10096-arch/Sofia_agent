import test from "node:test";
import assert from "node:assert/strict";
import { classifyTask } from "../src/agent/classifier.js";
import { ModelRouter } from "../src/models/router.js";

test("classifies coding work without exposing a model choice", () => {
  assert.equal(classifyTask("Fix the React TypeScript error"), "debugging");
});

test("routes coding to a capable internal route", () => {
  const router = new ModelRouter([
    { id: "fast", capabilities: ["fast"], costWeight: 1, latencyWeight: 1, qualityWeight: 5, healthy: true },
    { id: "coder", capabilities: ["coding", "tool-use", "reasoning"], costWeight: 2, latencyWeight: 2, qualityWeight: 8, healthy: true },
  ]);

  assert.equal(router.select("coding").id, "coder");
});


test("explicit route selection honors a user preference and exposes safe route metadata", () => {
  const router = new ModelRouter([
    { id: "fast", model: "vendor/fast-model", capabilities: ["fast"], costWeight: 1, latencyWeight: 1, qualityWeight: 5, healthy: true },
    { id: "coder", model: "vendor/coding-model", capabilities: ["coding", "tool-use", "reasoning"], costWeight: 2, latencyWeight: 2, qualityWeight: 8, healthy: true },
  ]);

  assert.equal(router.select("general").id, "fast");
  assert.equal(router.select("general", "coder").id, "coder");
  assert.deepEqual(router.listRoutes().map((route) => ({ id: route.id, model: route.model })), [
    { id: "fast", model: "vendor/fast-model" },
    { id: "coder", model: "vendor/coding-model" },
  ]);
  assert.throws(() => router.select("general", "missing"), /Unknown model route/);
});


test("router skips a route explicitly declared without vision support", () => {
  const router = new ModelRouter([
    { id: "preferred-but-no-vision", capabilities: ["vision", "reasoning"], costWeight: 1, latencyWeight: 1, qualityWeight: 10, healthy: true, featureSupport: { vision: false } },
    { id: "vision-capable", capabilities: ["vision", "reasoning"], costWeight: 2, latencyWeight: 2, qualityWeight: 5, healthy: true, featureSupport: { vision: true } },
  ]);

  assert.equal(router.select("vision").id, "vision-capable");
});

test("router skips a route explicitly declared without tool calling for coding tasks", () => {
  const router = new ModelRouter([
    { id: "no-tools", capabilities: ["coding", "tool-use", "reasoning"], costWeight: 1, latencyWeight: 1, qualityWeight: 10, healthy: true, featureSupport: { toolCalling: false } },
    { id: "with-tools", capabilities: ["coding", "tool-use", "reasoning"], costWeight: 2, latencyWeight: 2, qualityWeight: 5, healthy: true, featureSupport: { toolCalling: true } },
  ]);

  assert.equal(router.select("coding").id, "with-tools");
});

test("router preserves backward compatibility when capability metadata is unknown", () => {
  const router = new ModelRouter([
    { id: "legacy", capabilities: ["vision", "reasoning"], costWeight: 1, latencyWeight: 1, qualityWeight: 10, healthy: true },
  ]);

  assert.equal(router.select("vision").id, "legacy");
});


test("explicit model preference rejects a route declared without vision", () => {
  const router = new ModelRouter([
    { id: "no-vision", capabilities: ["vision", "reasoning"], costWeight: 1, latencyWeight: 1, qualityWeight: 10, healthy: true, featureSupport: { vision: false } },
  ]);

  assert.throws(() => router.select("vision", "no-vision"), /does not support vision/);
});

test("explicit model preference rejects a route declared without tool calling for coding", () => {
  const router = new ModelRouter([
    { id: "no-tools", capabilities: ["coding", "tool-use", "reasoning"], costWeight: 1, latencyWeight: 1, qualityWeight: 10, healthy: true, featureSupport: { toolCalling: false } },
  ]);

  assert.throws(() => router.select("coding", "no-tools"), /does not support tool calling/);
});


test("route listing cannot mutate internal capability metadata", () => {
  const router = new ModelRouter([
    {
      id: "vision-route",
      capabilities: ["vision", "reasoning"],
      costWeight: 1,
      latencyWeight: 1,
      qualityWeight: 10,
      healthy: true,
      featureSupport: { vision: true, toolCalling: true },
    },
    {
      id: "fallback",
      capabilities: ["vision", "reasoning"],
      costWeight: 2,
      latencyWeight: 2,
      qualityWeight: 5,
      healthy: true,
      featureSupport: { vision: true, toolCalling: true },
    },
  ]);

  const listed = router.listRoutes();
  const exposed = listed.find((route) => route.id === "vision-route");
  assert.ok(exposed?.featureSupport);
  exposed.featureSupport.vision = false;
  exposed.featureSupport.toolCalling = false;
  exposed.capabilities.length = 0;

  assert.equal(router.select("vision").id, "vision-route");
  assert.equal(router.select("coding", "vision-route").id, "vision-route");
});
