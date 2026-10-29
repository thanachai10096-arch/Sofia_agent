import assert from "node:assert/strict";
import test from "node:test";
import { SofiaModelGateway } from "./gateway.js";
import { createInternalRoute } from "../brain/model-route-adapter.js";
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


test("Brain route adapter enforces explicitly declared feature support", () => {
  const modelProvider = {
    async generate() {
      return { text: "{}", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };

  const unsupported = createInternalRoute({
    modelProvider,
    route: {
      ...route,
      capabilities: ["coding", "tool-use", "vision", "reasoning"],
      featureSupport: {
        toolCalling: false,
        vision: false,
        structuredOutput: false,
      },
    },
  });
  assert.equal(unsupported.capabilities.includes("tool-use"), false);
  assert.equal(unsupported.capabilities.includes("vision"), false);
  assert.equal(unsupported.capabilities.includes("structured-output"), false);

  const declared = createInternalRoute({
    modelProvider,
    route: {
      ...route,
      capabilities: ["coding", "reasoning"],
      featureSupport: {
        toolCalling: true,
        vision: true,
        structuredOutput: true,
      },
    },
  });
  assert.equal(declared.capabilities.includes("tool-use"), true);
  assert.equal(declared.capabilities.includes("vision"), true);
  assert.equal(declared.capabilities.includes("structured-output"), true);

  const legacy = createInternalRoute({ modelProvider, route });
  assert.deepEqual(legacy.capabilities, route.capabilities);
});

test("Brain route adapter rejects invalid token limit environment overrides", () => {
  const originalContext = process.env.SOFIA_CODING_CONTEXT;
  const originalMaxOutput = process.env.SOFIA_CODING_MAX_OUTPUT;
  const modelProvider = {
    async generate() {
      return { text: "{}", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };

  try {
    process.env.SOFIA_CODING_CONTEXT = "0";
    assert.throws(
      () => createInternalRoute({ modelProvider, route }),
      /Invalid SOFIA_CODING_CONTEXT: expected a positive safe integer/,
    );

    delete process.env.SOFIA_CODING_CONTEXT;
    process.env.SOFIA_CODING_MAX_OUTPUT = "1.5";
    assert.throws(
      () => createInternalRoute({ modelProvider, route }),
      /Invalid SOFIA_CODING_MAX_OUTPUT: expected a positive safe integer/,
    );

    process.env.SOFIA_CODING_MAX_OUTPUT = "not-a-number";
    assert.throws(
      () => createInternalRoute({ modelProvider, route }),
      /Invalid SOFIA_CODING_MAX_OUTPUT: expected a positive safe integer/,
    );
  } finally {
    if (originalContext === undefined) delete process.env.SOFIA_CODING_CONTEXT;
    else process.env.SOFIA_CODING_CONTEXT = originalContext;
    if (originalMaxOutput === undefined) delete process.env.SOFIA_CODING_MAX_OUTPUT;
    else process.env.SOFIA_CODING_MAX_OUTPUT = originalMaxOutput;
  }
});

test("Brain route adapter honors declared model context window and preserves legacy override", async () => {
  const originalContext = process.env.SOFIA_CODING_CONTEXT;
  const modelProvider = {
    async generate() {
      return { text: "{}", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };

  try {
    delete process.env.SOFIA_CODING_CONTEXT;
    const declared = createInternalRoute({
      modelProvider,
      route: { ...route, featureSupport: { contextWindow: 128_000 } },
    });
    assert.equal(declared.contextWindow, 128_000);

    process.env.SOFIA_CODING_CONTEXT = "64000";
    const overridden = createInternalRoute({
      modelProvider,
      route: { ...route, featureSupport: { contextWindow: 128_000 } },
    });
    assert.equal(overridden.contextWindow, 64_000);

    delete process.env.SOFIA_CODING_CONTEXT;
    const legacy = createInternalRoute({ modelProvider, route });
    assert.equal(legacy.contextWindow, 32_000);
  } finally {
    if (originalContext === undefined) delete process.env.SOFIA_CODING_CONTEXT;
    else process.env.SOFIA_CODING_CONTEXT = originalContext;
  }
});
