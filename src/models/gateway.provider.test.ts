import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { SofiaModelGateway } from "./gateway.js";
import type { ModelRequest, ModelRoute } from "./types.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const route: ModelRoute = {
  id: "fast",
  providerId: "fast",
  capabilities: ["fast", "tool-use"],
  costWeight: 1,
  latencyWeight: 1,
  qualityWeight: 5,
  healthy: true,
};

test("Anthropic adapter sends native Messages API headers and normalizes text and usage", async () => {
  let requestUrl = "";
  let requestHeaders = new Headers();
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-test-model",
      content: [{ type: "text", text: "Hello from Claude" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 11, output_tokens: 4 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const gateway = new SofiaModelGateway({
    fast: {
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "anthropic-test-key",
      model: "claude-test-model",
      protocol: "anthropic",
    },
  });
  const request: ModelRequest = {
    task: "Say hello",
    kind: "general",
    step: 1,
    messages: [{ role: "user", content: "Hi" }],
  };

  const response = await gateway.generate(request, route, { maxOutputTokens: 256 });
  assert.equal(requestUrl, "https://api.anthropic.com/v1/messages");
  assert.equal(requestHeaders.get("x-api-key"), "anthropic-test-key");
  assert.equal(requestHeaders.get("anthropic-version"), "2023-06-01");
  assert.equal(requestHeaders.get("authorization"), null);
  assert.equal(requestBody.model, "claude-test-model");
  assert.equal(requestBody.max_tokens, 256);
  assert.equal(response.text, "Hello from Claude");
  assert.deepEqual(response.usage, { inputTokens: 11, outputTokens: 4 });
});

test("Anthropic adapter maps tool definitions and normalizes tool_use blocks", async () => {
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "README.md" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 20, output_tokens: 7 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const gateway = new SofiaModelGateway({
    fast: {
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "anthropic-test-key",
      model: "claude-test-model",
      protocol: "anthropic",
    },
  });
  const request: ModelRequest = {
    task: "Read README",
    kind: "coding",
    step: 2,
    messages: [{ role: "user", content: "Read README.md" }],
    tools: [{
      type: "function",
      function: {
        name: "read_file",
        description: "Read a workspace file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    }],
  };

  const response = await gateway.generate(request, route);
  const tools = requestBody.tools as Array<Record<string, unknown>>;
  assert.equal(tools[0]?.name, "read_file");
  assert.deepEqual(tools[0]?.input_schema, request.tools?.[0]?.function.parameters);
  assert.equal(response.toolCalls?.[0]?.id, "toolu_1");
  assert.equal(response.toolCalls?.[0]?.name, "read_file");
  assert.deepEqual(response.toolCalls?.[0]?.input, { path: "README.md" });
});
