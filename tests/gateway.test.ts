import test from "node:test";
import assert from "node:assert/strict";
import { SofiaModelGateway } from "../src/models/gateway.js";
import type { ModelRequest, ModelRoute } from "../src/models/types.js";

const request: ModelRequest = { task: "hello", kind: "general", step: 1 };
const makeRoute = (): ModelRoute => ({
  id: "test-provider",
  capabilities: ["fast", "tool-use"],
  costWeight: 1,
  latencyWeight: 1,
  qualityWeight: 1,
  healthy: true,
});
const okResponse = () => new Response(JSON.stringify({
  choices: [{ message: { role: "assistant", content: "hello back" } }],
  usage: { prompt_tokens: 2, completion_tokens: 3 },
}), { status: 200, headers: { "content-type": "application/json" } });

test("gateway returns a validated assistant response and token usage", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => okResponse();
  try {
    const gateway = new SofiaModelGateway({
      "test-provider": { baseUrl: "https://example.test/v1", apiKey: "test", model: "test-model" },
    });
    const result = await gateway.generate(request, makeRoute());
    assert.equal(result.text, "hello back");
    assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 3 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway retries transient provider status and then succeeds", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? new Response("temporarily unavailable", { status: 503 })
      : okResponse();
  };
  try {
    const gateway = new SofiaModelGateway({
      "test-provider": { baseUrl: "https://example.test/v1", apiKey: "test", model: "test-model" },
    });
    const result = await gateway.generate(request, makeRoute());
    assert.equal(result.text, "hello back");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway rejects malformed and non-object tool arguments", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const args of ["[", "[]", "null", "42"]) {
      globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{ message: { content: "", tool_calls: [
          { id: "call-1", function: { name: "run", arguments: args } },
        ] } }],
      }), { status: 200, headers: { "content-type": "application/json" } });

      const gateway = new SofiaModelGateway({
        "test-provider": { baseUrl: "https://example.test/v1", apiKey: "test", model: "test-model" },
      });
      await assert.rejects(
        gateway.generate({ ...request, tools: [] }, makeRoute()),
        /invalid arguments for tool call/,
        `expected arguments ${JSON.stringify(args)} to be rejected`,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
