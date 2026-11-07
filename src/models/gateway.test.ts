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
        thinkingMode: "disabled",
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

test("DeepSeek structured Brain calls use OpenAI-compatible JSON Output even when Anthropic is configured", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedHeaders: Record<string, string> = {};
  let requestedBody: Record<string, unknown> = {};
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedHeaders = init?.headers as Record<string, string>;
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ mode: "conversation", response: "Hello", objective: "Reply", constraints: [], assumptions: [], requiredCapabilities: [], requiredTools: [], risk: "low", successCriteria: [], ambiguities: [] }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 25, completion_tokens: 30 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const gateway = new SofiaModelGateway({
      fast: {
        baseUrl: "https://api.deepseek.com/anthropic",
        apiKey: "deepseek-test-key",
        model: "deepseek-flash",
        protocol: "anthropic-messages",
      },
    });
    const result = await gateway.generate({
      task: "Say hello",
      kind: "general",
      step: 1,
      context: JSON.stringify({
        phase: "understand",
        instructions: "Return one JSON object",
        acceptanceCriteria: [],
      }),
    }, { ...route, id: "fast", providerId: "fast", capabilities: ["fast"] }, { maxOutputTokens: 700 });

    assert.equal(requestedUrl, "https://api.deepseek.com/chat/completions");
    assert.equal(requestedHeaders.authorization, "Bearer deepseek-test-key");
    assert.deepEqual(requestedBody.response_format, { type: "json_object" });
    assert.equal(requestedBody.model, "deepseek-flash");
    assert.equal(result.usage?.inputTokens, 25);
    assert.match(result.text, /"mode":"conversation"/);
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


test("Anthropic thinking mode is explicitly controlled in the request body", async () => {
  const originalFetch = globalThis.fetch;
  let requestedBody: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 3 } }), { status: 200 });
  };
  try {
    const gateway = new SofiaModelGateway({ coding: { baseUrl: "https://api.anthropic.com/v1", apiKey: "test", model: "deepseek-flash", protocol: "anthropic-messages", thinkingMode: "disabled" } });
    await gateway.generate({ task: "test", kind: "analysis", step: 1 }, route, { maxOutputTokens: 256 });
    assert.deepEqual(requestedBody.thinking, { type: "disabled" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic thinking-only content is preserved as a distinct failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ content: [{ type: "thinking", thinking: "private reasoning" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 20 } }), { status: 200 });
  try {
    const gateway = new SofiaModelGateway({ coding: { baseUrl: "https://api.anthropic.com/v1", apiKey: "test", model: "deepseek-flash", protocol: "anthropic-messages" } });
    await assert.rejects(gateway.generate({ task: "test", kind: "analysis", step: 1 }, route), /provider_thinking_only_output/);
  } finally { globalThis.fetch = originalFetch; }
});


for (const protocol of ["openai-compatible", "anthropic-messages"] as const) {
  test(`${protocol} request omits thinking when mode is unset`, async () => {
    const originalFetch = globalThis.fetch;
    let requestedBody: Record<string, unknown> = {};
    globalThis.fetch = async (_input, init) => {
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(protocol === "anthropic-messages"
        ? JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } })
        : JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    };
    try {
      const gateway = new SofiaModelGateway({ coding: {
        baseUrl: protocol === "anthropic-messages" ? "https://api.deepseek.com/anthropic" : "https://api.deepseek.com",
        apiKey: "test", model: "deepseek-flash", protocol,
      } });
      await gateway.generate({ task: "hello", kind: "analysis", step: 1 }, route);
      assert.equal("thinking" in requestedBody, false);
    } finally { globalThis.fetch = originalFetch; }
  });


  test(`${protocol} request sends enabled thinking mode when configured`, async () => {
    const originalFetch = globalThis.fetch;
    let requestedBody: Record<string, unknown> = {};
    globalThis.fetch = async (_input, init) => {
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(protocol === "anthropic-messages"
        ? JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } })
        : JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    };
    try {
      const gateway = new SofiaModelGateway({ coding: {
        baseUrl: protocol === "anthropic-messages" ? "https://api.deepseek.com/anthropic" : "https://api.deepseek.com",
        apiKey: "test", model: "deepseek-flash", protocol, thinkingMode: "enabled",
      } });
      await gateway.generate({ task: "hello", kind: "analysis", step: 1 }, route);
      assert.deepEqual(requestedBody.thinking, { type: "enabled" });
    } finally { globalThis.fetch = originalFetch; }
  });

  test(`${protocol} request sends configured thinking mode`, async () => {
    const originalFetch = globalThis.fetch;
    let requestedBody: Record<string, unknown> = {};
    globalThis.fetch = async (_input, init) => {
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(protocol === "anthropic-messages"
        ? JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } })
        : JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    };
    try {
      const gateway = new SofiaModelGateway({ coding: {
        baseUrl: protocol === "anthropic-messages" ? "https://api.deepseek.com/anthropic" : "https://api.deepseek.com",
        apiKey: "test", model: "deepseek-flash", protocol, thinkingMode: "disabled",
      } });
      await gateway.generate({ task: "hello", kind: "analysis", step: 1 }, route);
      assert.deepEqual(requestedBody.thinking, { type: "disabled" });
    } finally { globalThis.fetch = originalFetch; }
  });
}


test("Anthropic thinking-only recovery preserves explicitly disabled thinking mode", async () => {
  const originalFetch = globalThis.fetch;
  const requestedBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    requestedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const response = requestedBodies.length === 1
      ? { content: [{ type: "thinking", thinking: "private reasoning" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 20 } }
      : { content: [{ type: "text", text: "final answer" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 3 } };
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const gateway = new SofiaModelGateway({
      coding: {
        baseUrl: "https://api.deepseek.com/anthropic",
        apiKey: "test",
        model: "deepseek-flash",
        protocol: "anthropic-messages",
        thinkingMode: "disabled",
      },
    });
    const result = await gateway.generate({ task: "test", kind: "analysis", step: 1 }, route);
    assert.equal(result.text, "final answer");
    assert.equal(requestedBodies.length, 2);
    assert.deepEqual(requestedBodies[0]?.thinking, { type: "disabled" });
    assert.deepEqual(requestedBodies[1]?.thinking, { type: "disabled" });
    assert.match(String(requestedBodies[1]?.system), /Return the final user-facing answer now/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic thinking-only recovery explicitly disables provider-default thinking", async () => {
  const originalFetch = globalThis.fetch;
  const requestedBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    requestedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const response = requestedBodies.length === 1
      ? { content: [{ type: "thinking", thinking: "private reasoning" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 20 } }
      : { content: [{ type: "text", text: JSON.stringify({ ok: true }) }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 3 } };
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const gateway = new SofiaModelGateway({
      coding: {
        baseUrl: "https://api.deepseek.com/anthropic",
        apiKey: "test",
        model: "deepseek-chat",
        protocol: "anthropic-messages",
        // Deliberately unset: recovery must override provider-default thinking.
      },
    });
    const result = await gateway.generate({ task: "test", kind: "analysis", step: 1 }, route);
    assert.equal(result.text, JSON.stringify({ ok: true }));
    assert.equal(requestedBodies.length, 2);
    assert.equal("thinking" in requestedBodies[0]!, false);
    assert.deepEqual(requestedBodies[1]?.thinking, { type: "disabled" });
    assert.match(String(requestedBodies[1]?.system), /Return the final user-facing answer now/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
