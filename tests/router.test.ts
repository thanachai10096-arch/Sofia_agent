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


test("does not route vision tasks to models declared without vision support", () => {
  const router = new ModelRouter([
    { id: "fast-text", capabilities: ["vision", "reasoning"], features: { vision: false }, costWeight: 0, latencyWeight: 0, qualityWeight: 10, healthy: true },
    { id: "vision-model", capabilities: ["vision", "reasoning"], features: { vision: true }, costWeight: 3, latencyWeight: 3, qualityWeight: 6, healthy: true },
  ]);
  assert.equal(router.select("vision").id, "vision-model");
});

test("does not route tool-using tasks to models declared without tool calling", () => {
  const router = new ModelRouter([
    { id: "no-tools", capabilities: ["coding", "tool-use", "reasoning"], features: { toolCalling: false }, costWeight: 0, latencyWeight: 0, qualityWeight: 10, healthy: true },
    { id: "with-tools", capabilities: ["coding", "tool-use", "reasoning"], features: { toolCalling: true }, costWeight: 3, latencyWeight: 3, qualityWeight: 6, healthy: true },
  ]);
  assert.equal(router.select("coding").id, "with-tools");
});
