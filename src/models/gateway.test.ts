import assert from "node:assert/strict";
import test from "node:test";
import { SofiaModelGateway } from "./gateway.js";
import type { ModelRequest, ModelRoute } from "./types.js";

const route: ModelRoute = {
  id: "coding",
  providerId: "coding",
  model: "claude-test-model",
  capabilities: ["coding", "tool-use", "reasoning"],
  costWeight: 1,
  latencyWeight: 1,
  qualityWeight: 8,
  healthy: true,
};

test("Anthropic Messages adapter sends native tool schema and normalizes tool-use responses", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedHeaders: Record<string, string> = {};
  let requestedBody: Record<string, unknown> = {};
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedHeaders = init?.headers as Record<string, string>;
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "I will read the file." },
        { type: "tool_use", id: "toolu_1", name: "workspace.read_file", input: { path: "README.md" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 42, output_tokens: 12 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const gateway = new SofiaModelGateway({
      coding: {
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "anthropic-secret",
        model: "claude-test-model",
        protocol: "anthropic-messages",
      },
    });
    const request: ModelRequest = {
      task: "Read README.md",
      kind: "coding",
      step: 1,
      messages: [
        { role: "system", content: "You are Sofia." },
        { role: "user", content: "Read README.md" },
      ],
      tools: [{
        type: "function",
        function: {
          name: "workspace.read_file",
          description: "Read a workspace file.",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      }],
    };
    const result = await gateway.generate(request, route, { maxOutputTokens: 512 });

    assert.equal(requestedUrl, "https://api.anthropic.com/v1/messages");
    assert.equal(requestedHeaders["x-api-key"], "anthropic-secret");
    assert.equal(requestedHeaders["anthropic-version"], "2023-06-01");
    assert.equal(requestedHeaders.authorization, undefined);
    assert.equal(requestedBody.model, "claude-test-model");
    assert.equal(requestedBody.max_tokens, 512);
    assert.equal(requestedBody.system, "You are Sofia.");
    assert.deepEqual(requestedBody.messages, [{ role: "user", content: "Read README.md" }]);
    assert.deepEqual(requestedBody.tools, [{
      name: "workspace.read_file",
      description: "Read a workspace file.",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }]);
    assert.deepEqual(result.toolCalls, [{
      id: "toolu_1",
      name: "workspace.read_file",
      input: { path: "README.md" },
    }]);
    assert.equal(result.text, "I will read the file.");
    assert.deepEqual(result.usage, { inputTokens: 42, outputTokens: 12 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic adapter adds JSON-only instructions for structured Brain requests", async () => {
  const originalFetch = globalThis.fetch;
  let requestedBody: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      content: [{ type: "text", text: "{\"ok\":true}" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const gateway = new SofiaModelGateway({
      coding: {
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "anthropic-secret",
        model: "claude-test-model",
        protocol: "anthropic-messages",
      },
    });
    const result = await gateway.generate({
      task: "plan the task",
      kind: "analysis",
      step: 1,
      context: JSON.stringify({ phase: "plan", instructions: "Return an object", acceptanceCriteria: [] }),
    }, route, { maxOutputTokens: 256 });

    assert.match(String(requestedBody.system), /exactly one valid JSON object/);
    assert.equal("response_format" in requestedBody, false);
    assert.equal(result.text, "{\"ok\":true}");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible structured Brain requests explicitly instruct JSON-only output", async () => {
  const originalFetch = globalThis.fetch;
  let requestedBody: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }), { status: 200 });
  };
  try {
    const gateway = new SofiaModelGateway({
      coding: { baseUrl: "https://api.deepseek.com", apiKey: "test-secret", model: "deepseek-chat" },
    });
    await gateway.generate({
      task: "understand task", kind: "analysis", step: 1,
      context: JSON.stringify({ phase: "understand", instructions: "Return object", acceptanceCriteria: [] }),
    }, route, { maxOutputTokens: 256 });
    assert.deepEqual(requestedBody.response_format, { type: "json_object" });
    const messages = requestedBody.messages as Array<{ role: string; content: string }>;
    assert.match(messages[0]?.content ?? "", /JSON/);
    assert.match(messages[0]?.content ?? "", /exactly one valid JSON object/);
  } finally { globalThis.fetch = originalFetch; }
});


test("Anthropic thinking can be explicitly disabled", async () => {
  const originalFetch = globalThis.fetch;
  const originalThinking = process.env.SOFIA_MODEL_THINKING;
  let requestedBody: Record<string, unknown> = {};
  process.env.SOFIA_MODEL_THINKING = "disabled";
  globalThis.fetch = async (_input, init) => {
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ content: [{ type: "text", text: "{\\"ok\\":true}" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 3 } }), { status: 200 });
  };
  try {
    const gateway = new SofiaModelGateway({ coding: { baseUrl: "https://api.anthropic.com/v1", apiKey: "test", model: "deepseek-flash", protocol: "anthropic-messages" } });
    await gateway.generate({ task: "test", kind: "analysis", step: 1 }, route, { maxOutputTokens: 256 });
    assert.deepEqual(requestedBody.thinking, { type: "disabled" });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalThinking === undefined) delete process.env.SOFIA_MODEL_THINKING;
    else process.env.SOFIA_MODEL_THINKING = originalThinking;
  }
});

test("Anthropic thinking-only content is preserved as a distinct failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ content: [{ type: "thinking", thinking: "private reasoning" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 20 } }), { status: 200 });
  try {
    const gateway = new SofiaModelGateway({ coding: { baseUrl: "https://api.anthropic.com/v1", apiKey: "test", model: "deepseek-flash", protocol: "anthropic-messages" } });
    await assert.rejects(gateway.generate({ task: "test", kind: "analysis", step: 1 }, route), /thinking-only content/);
  } finally { globalThis.fetch = originalFetch; }
});
