import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { discoverModels, probeModelCapabilities } from "./discovery.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("discovers OpenAI-compatible model IDs and does not invent capability metadata", async () => {
  let requestUrl = "";
  let authorization = "";
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({
      data: [
        { id: "model-a", owned_by: "provider", created: 123, context_length: 32768 },
        { id: "model-a", owned_by: "provider" },
        { id: "model-b", context_window: 8192 },
        { name: "malformed" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const models = await discoverModels({
    baseUrl: "https://models.example.test/v1/",
    apiKey: "test-secret",
  });
  assert.equal(requestUrl, "https://models.example.test/v1/models");
  assert.equal(authorization, "Bearer test-secret");
  assert.deepEqual(models, [
    { id: "model-a", ownedBy: "provider", created: 123, contextWindow: 32768, capabilities: null },
    { id: "model-b", contextWindow: 8192, capabilities: null },
  ]);
});

test("uses Anthropic authentication for native model discovery", async () => {
  let headers = new Headers();
  globalThis.fetch = async (_input, init) => {
    headers = new Headers(init?.headers);
    return new Response(JSON.stringify({
      data: [{ id: "claude-model", display_name: "Claude Model" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const models = await discoverModels({
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "anthropic-secret",
    protocol: "anthropic",
  });
  assert.equal(headers.get("x-api-key"), "anthropic-secret");
  assert.equal(headers.get("anthropic-version"), "2023-06-01");
  assert.equal(headers.get("authorization"), null);
  assert.deepEqual(models, [{ id: "claude-model", displayName: "Claude Model", capabilities: null }]);
});

test("probes actual OpenAI-compatible chat and tool-call behavior without executing tools", async () => {
  let calls = 0;
  let toolChoice: unknown;
  globalThis.fetch = async (_input, init) => {
    calls++;
    const body = JSON.parse(String(init?.body)) as { tool_choice?: unknown };
    toolChoice = body.tool_choice;
    return new Response(JSON.stringify(calls === 1
      ? { choices: [{ message: { role: "assistant", content: "OK" } }] }
      : { choices: [{ message: { role: "assistant", tool_calls: [{ id: "call-1", function: { name: "report_probe", arguments: "{\"ok\":true}" } }] } }] }),
    { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await probeModelCapabilities({
    baseUrl: "https://models.example.test/v1",
    apiKey: "test-secret",
    model: "test-model",
  });
  assert.equal(calls, 2);
  assert.deepEqual(toolChoice, { type: "function", function: { name: "report_probe" } });
  assert.deepEqual(result, {
    model: "test-model",
    chat: "supported",
    toolUse: "supported",
    verifiedCapabilities: ["tool-use"],
  });
});

test("probes Anthropic tool use with native headers and does not infer unsupported capabilities", async () => {
  let calls = 0;
  let auth = "";
  globalThis.fetch = async (_input, init) => {
    calls++;
    auth = new Headers(init?.headers).get("x-api-key") ?? "";
    return new Response(JSON.stringify(calls === 1
      ? { content: [{ type: "text", text: "OK" }] }
      : { content: [{ type: "tool_use", id: "toolu_1", name: "report_probe", input: { ok: true } }] }),
    { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await probeModelCapabilities({
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "secret",
    model: "claude-test",
    protocol: "anthropic",
  });
  assert.equal(calls, 2);
  assert.equal(auth, "secret");
  assert.deepEqual(result.verifiedCapabilities, ["tool-use"]);
  assert.equal(result.toolUse, "supported");
});

test("reports tool support as unknown when endpoint rejects tool calling", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 })
      : new Response(JSON.stringify({ error: "tools unsupported" }), { status: 400 });
  };
  const result = await probeModelCapabilities({
    baseUrl: "https://models.example.test/v1",
    model: "no-tools-model",
  });
  assert.equal(result.toolUse, "unknown");
  assert.deepEqual(result.verifiedCapabilities, []);
});

test("rejects unsafe URLs, bad response shapes, and non-success discovery responses", async () => {
  await assert.rejects(discoverModels({ baseUrl: "http://models.example.test/v1" }), /HTTPS/);
  await assert.rejects(discoverModels({ baseUrl: "https://user:pass@models.example.test/v1" }), /must not contain credentials/);

  globalThis.fetch = async () => new Response(JSON.stringify({ models: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  await assert.rejects(discoverModels({ baseUrl: "https://models.example.test/v1" }), /unsupported response shape/);

  globalThis.fetch = async () => new Response("denied", { status: 403 });
  await assert.rejects(discoverModels({ baseUrl: "https://models.example.test/v1" }), /HTTP 403/);
});


test("extended probe verifies accepted image input and valid JSON-object output", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const messages = body.messages as Array<{ content: unknown }>;
    const isVision = Array.isArray(messages[0]?.content);
    if (isVision) {
      const parts = messages[0]?.content as Array<Record<string, unknown>>;
      assert.equal(parts.some((part) => part.type === "image_url"), true);
      return new Response(JSON.stringify({ choices: [{ message: { content: "A tiny test image." } }] }), { status: 200 });
    }
    assert.deepEqual(body.response_format, { type: "json_object" });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] }), { status: 200 });
  };
  const { probeExtendedModelCapabilities } = await import("./discovery.js");
  const result = await probeExtendedModelCapabilities({
    baseUrl: "https://models.example.test/v1",
    model: "multimodal-test-model",
  });
  assert.equal(bodies.length, 2);
  assert.deepEqual(result, {
    model: "multimodal-test-model",
    visionInput: "accepted",
    jsonObjectOutput: "verified",
  });
});

test("extended probe leaves capabilities unknown when the endpoint rejects them", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "not supported" }), { status: 400 });
  const { probeExtendedModelCapabilities } = await import("./discovery.js");
  const result = await probeExtendedModelCapabilities({
    baseUrl: "https://models.example.test/v1",
    model: "text-only-model",
  });
  assert.equal(result.visionInput, "unknown");
  assert.equal(result.jsonObjectOutput, "unknown");
});
