import assert from "node:assert/strict";
import test from "node:test";

import { createInternalRoute } from "./model-route-adapter.js";
import type { ModelProvider, ModelRoute } from "../models/types.js";

const route: ModelRoute = {
  id: "reasoning",
  providerId: "reasoning",
  model: "test-model",
  capabilities: ["reasoning", "long-context"],
  costWeight: 1,
  latencyWeight: 1,
  qualityWeight: 9,
  healthy: true,
};

function makePrompt() {
  return {
    core: {
      task: "Plan a task",
      instructions: "Return structured JSON",
      acceptanceCriteria: ["Return an object"],
      state: { phase: "plan" },
      toolSchemas: [],
    },
    evidence: [],
  };
}

test("provider MAX_TOKENS finish reason is treated as truncation before JSON parsing", async () => {
  const provider: ModelProvider = {
    async generate() {
      return {
        text: '{"partial":',
        usage: { inputTokens: 12, outputTokens: 20 },
        finishReason: "MAX_TOKENS",
      };
    },
  };
  const internalRoute = createInternalRoute({ modelProvider: provider, route });
  const prepared = internalRoute.prepare(makePrompt());
  const result = await prepared.invoke({
    signal: new AbortController().signal,
    maxOutputTokens: 256,
    requestId: "test-request",
    maxAttempts: 1,
  });

  assert.equal(result.value, null);
  assert.equal(result.finishReason, "length");
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 20 });
});

test("provider finish reasons with spaces or hyphens normalize to truncation", async () => {
  const provider: ModelProvider = {
    async generate() {
      return {
        text: '{"partial":',
        usage: { inputTokens: 4, outputTokens: 8 },
        finishReason: "max output-tokens",
      };
    },
  };
  const internalRoute = createInternalRoute({ modelProvider: provider, route });
  const result = await internalRoute.prepare(makePrompt()).invoke({
    signal: new AbortController().signal,
    maxOutputTokens: 256,
    requestId: "test-request",
    maxAttempts: 1,
  });

  assert.equal(result.value, null);
  assert.equal(result.finishReason, "length");
});
