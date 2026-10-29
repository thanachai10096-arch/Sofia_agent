import assert from "node:assert/strict";
import test from "node:test";
import { buildModelCapabilityReport } from "./capability-report.js";
import type { ModelRoute } from "./types.js";

function route(overrides: Partial<ModelRoute> = {}): ModelRoute {
  return {
    id: "test-route",
    capabilities: ["fast"],
    costWeight: 1,
    latencyWeight: 1,
    qualityWeight: 1,
    healthy: true,
    ...overrides,
  };
}

test("capability report labels undeclared features unknown rather than guessing from route ID", () => {
  const [report] = buildModelCapabilityReport([route({ id: "vision-reasoning-model" })]);
  assert.ok(report);
  assert.deepEqual(report.capabilities.vision, { value: "unknown", source: "unknown" });
  assert.deepEqual(report.capabilities.toolCalling, { value: "unknown", source: "unknown" });
  assert.deepEqual(report.capabilities.structuredOutput, { value: "unknown", source: "unknown" });
  assert.deepEqual(report.capabilities.contextWindow, { value: "unknown", source: "unknown" });
});

test("capability report preserves explicit true, false, and context-window declarations", () => {
  const [report] = buildModelCapabilityReport([route({
    features: { toolCalling: true, vision: false, structuredOutput: true, contextWindow: 65536 },
  })]);
  assert.ok(report);
  assert.deepEqual(report.capabilities, {
    toolCalling: { value: true, source: "operator-declared" },
    vision: { value: false, source: "operator-declared" },
    structuredOutput: { value: true, source: "operator-declared" },
    contextWindow: { value: 65536, source: "operator-declared" },
  });
});

test("capability report includes each route and performs no implicit provider assumptions", () => {
  const reports = buildModelCapabilityReport([
    route({ id: "openai-compatible" }),
    route({ id: "anthropic-messages", features: { vision: true } }),
  ]);
  assert.deepEqual(reports.map((item) => item.routeId), ["openai-compatible", "anthropic-messages"]);
  assert.equal(reports[1]?.capabilities.vision.value, true);
  assert.equal(reports[1]?.capabilities.toolCalling.value, "unknown");
});
