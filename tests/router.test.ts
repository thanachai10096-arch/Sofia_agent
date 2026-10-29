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
