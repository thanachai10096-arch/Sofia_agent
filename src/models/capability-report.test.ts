import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModelCapabilityReport } from "./capability-report.js";
import type { ModelRoute } from "./types.js";

function route(overrides: Partial<ModelRoute> = {}): ModelRoute {
  return {
    id: "fast",
    providerId: "provider-a",
    model: "vendor/model-x",
    capabilities: ["fast"],
    costWeight: 1,
    latencyWeight: 1,
    qualityWeight: 1,
    healthy: true,
    ...overrides,
  };
}

test("capability report marks undeclared features unknown rather than guessing", () => {
  const [entry] = buildModelCapabilityReport([route()]);
  assert.ok(entry);
  assert.equal(entry.toolCalling, "unknown");
  assert.equal(entry.vision, "unknown");
  assert.equal(entry.structuredOutput, "unknown");
  assert.equal(entry.contextWindow, "unknown");
});

test("capability report exposes only explicitly declared feature metadata", () => {
  const [entry] = buildModelCapabilityReport([route({
    featureSupport: {
      toolCalling: true,
      vision: false,
      structuredOutput: true,
      contextWindow: 128_000,
    },
  })]);
  assert.ok(entry);
  assert.equal(entry.toolCalling, true);
  assert.equal(entry.vision, false);
  assert.equal(entry.structuredOutput, true);
  assert.equal(entry.contextWindow, 128_000);
  assert.equal("apiKey" in entry, false);
});

test("capability report provides safe fallbacks for missing route identifiers", () => {
  const [entry] = buildModelCapabilityReport([route({
    providerId: undefined,
    model: undefined,
  })]);
  assert.ok(entry);
  assert.equal(entry.providerId, "fast");
  assert.equal(entry.model, "unknown");
});
