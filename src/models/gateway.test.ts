import assert from "node:assert/strict";
import test from "node:test";
import { SofiaModelGateway } from "./gateway.js";
import type { ModelRoute } from "./types.js";

const route: ModelRoute = {
  id: "fast",
  providerId: "test",
  capabilities: ["fast"],
  costWeight: 1,
  latencyWeight: 1,
  qualityWeight: 5,
  healthy: true,
};

test("falls back to OpenRouter Auto Router when the configured model returns 404", async () => {
  const requestedModels: string[] = [];
  const gateway = new SofiaModelGateway({
    test: {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "test-key",
      model: "provider/missing-model",
      fallbackModel: "openrouter/auto",
      fetchImpl: async (_input, init) => {
        requestedModels.push(JSON.parse(String(init?.body)).model);
        if (requestedModels.length === 1) {
          return new Response("model not found", { status: 404 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: "ready" } }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    },
  });

  const result = await gateway.generate(
    { task: "hello", kind: "general", step: 1 },
    route,
  );

  assert.deepEqual(requestedModels, ["provider/missing-model", "openrouter/auto"]);
  assert.equal(result.text, "ready");
  assert.equal(route.healthy, true);
});

test("does not mask authentication errors with model fallback", async () => {
  let calls = 0;
  const gateway = new SofiaModelGateway({
    test: {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "test-key",
      model: "provider/restricted-model",
      fallbackModel: "openrouter/auto",
      fetchImpl: async () => {
        calls += 1;
        return new Response("forbidden", { status: 403 });
      },
    },
  });

  await assert.rejects(
    gateway.generate({ task: "hello", kind: "general", step: 1 }, { ...route }),
    /Model gateway request failed \(403\)/,
  );
  assert.equal(calls, 1);
});


test("keeps non-retryable OpenRouter 402 errors visible instead of opening the circuit", async () => {
  let calls = 0;
  const testRoute = { ...route, healthy: true };
  const gateway = new SofiaModelGateway({
    test: {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "test-key",
      model: "openrouter/free",
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          error: { message: "Payment required" },
        }), { status: 402, headers: { "content-type": "application/json" } });
      },
    },
  });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assert.rejects(
      gateway.generate({ task: "hello", kind: "general", step: attempt + 1 }, testRoute),
      /Model gateway request failed \\(402\\)/,
    );
  }

  assert.equal(calls, 4);
  assert.equal(testRoute.healthy, true);
});
