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


test("gateway enforces one timeout budget across the provider request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error("missing request signal"));
      const onAbort = () => reject(signal.reason ?? new Error("aborted"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  try {
    const gateway = new SofiaModelGateway({
      "test-provider": {
        baseUrl: "https://example.test/v1",
        apiKey: "test",
        model: "test-model",
        requestTimeoutMs: 30,
      },
    });
    await assert.rejects(gateway.generate(request, makeRoute()), /timeout|timed out/i);
    assert.equal(calls, 1, "a timed-out request must not start another retry");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway keeps configured API credentials from being overwritten by custom headers", async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders: HeadersInit | undefined;
  globalThis.fetch = async (_input, init) => {
    capturedHeaders = init?.headers;
    return okResponse();
  };
  try {
    const gateway = new SofiaModelGateway({
      "test-provider": {
        baseUrl: "https://example.test/v1",
        apiKey: "real-test-key",
        model: "test-model",
        headers: { authorization: "Bearer wrong-key", "content-type": "text/plain" },
      },
    });
    await gateway.generate(request, makeRoute());
    const headers = new Headers(capturedHeaders);
    assert.equal(headers.get("authorization"), "Bearer real-test-key");
    assert.equal(headers.get("content-type"), "application/json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway rejects unsafe concurrency and timeout configuration", () => {
  assert.throws(() => new SofiaModelGateway({
    "test-provider": { baseUrl: "https://example.test/v1", apiKey: "test", model: "test-model", maxConcurrent: 0 },
  }), /Invalid maxConcurrent/);
  assert.throws(() => new SofiaModelGateway({
    "test-provider": { baseUrl: "https://example.test/v1", apiKey: "test", model: "test-model", requestTimeoutMs: -1 },
  }), /Invalid requestTimeoutMs/);
});


test("gateway normalizes Gemini typed text content parts", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content: [
      { type: "text", text: "  Hello" },
      { type: "text", text: "from Gemini  " },
      { type: "image", image_url: "ignored" },
    ] } }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const gateway = new SofiaModelGateway({
      "test-provider": { baseUrl: "https://example.test/v1", apiKey: "test", model: "test-model" },
    });
    const result = await gateway.generate(request, makeRoute());
    assert.equal(result.text, "Hello\nfrom Gemini");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway reports finish reason for a response without usable content", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ finish_reason: "MAX_TOKENS", message: { role: "assistant", content: "" } }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const gateway = new SofiaModelGateway({
      "test-provider": { baseUrl: "https://example.test/v1", apiKey: "test", model: "test-model" },
    });
    await assert.rejects(gateway.generate(request, makeRoute()), /finish_reason=MAX_TOKENS/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("gateway requests JSON mode for structured Brain calls without tools", async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: JSON.stringify({ summary: "ok" }) } }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const gateway = new SofiaModelGateway({
      "test-provider": { baseUrl: "https://example.test/v1", apiKey: "test", model: "test-model" },
    });
    await gateway.generate({
      ...request,
      context: JSON.stringify({
        phase: "plan",
        instructions: "Return a JSON object",
        acceptanceCriteria: ["valid JSON"],
      }),
    }, makeRoute());
    assert.deepEqual(body?.response_format, { type: "json_object" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic-compatible gateway retries a thinking-only response without thinking mode", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const payload = bodies.length === 1
      ? {
          content: [{ type: "thinking", thinking: "private reasoning" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 2, output_tokens: 4 },
        }
      : {
          content: [{ type: "text", text: '{"summary":"ready"}' }],
          stop_reason: "end_turn",
          usage: { input_tokens: 2, output_tokens: 3 },
        };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const gateway = new SofiaModelGateway({
      "test-provider": {
        baseUrl: "https://example.test/v1",
        apiKey: "test",
        model: "deepseek-test",
        protocol: "anthropic-messages",
        thinkingMode: "disabled",
      },
    });
    const result = await gateway.generate(request, makeRoute());
    assert.equal(result.text, '{"summary":"ready"}');
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0]?.thinking, { type: "disabled" });
    assert.equal("thinking" in (bodies[1] ?? {}), false);
    assert.match(String(bodies[1]?.system), /Do not emit thinking or reasoning blocks/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway leaves JSON mode disabled for ordinary chat", async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return okResponse();
  };
  try {
    const gateway = new SofiaModelGateway({
      "test-provider": { baseUrl: "https://example.test/v1", apiKey: "test", model: "test-model" },
    });
    await gateway.generate(request, makeRoute());
    assert.equal("response_format" in (body ?? {}), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
