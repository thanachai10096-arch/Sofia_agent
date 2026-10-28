import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { discoverModels } from "./discovery.js";

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
        { id: "model-a", owned_by: "provider", created: 123 },
        { id: "model-a", owned_by: "provider" },
        { id: "model-b" },
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
    { id: "model-a", ownedBy: "provider", created: 123, capabilities: null },
    { id: "model-b", capabilities: null },
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

test("rejects unsafe URLs, bad response shapes, and non-success responses", async () => {
  await assert.rejects(
    discoverModels({ baseUrl: "http://models.example.test/v1" }),
    /HTTPS/,
  );
  await assert.rejects(
    discoverModels({ baseUrl: "https://user:pass@models.example.test/v1" }),
    /must not contain credentials/,
  );

  globalThis.fetch = async () => new Response(JSON.stringify({ models: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  await assert.rejects(
    discoverModels({ baseUrl: "https://models.example.test/v1" }),
    /unsupported response shape/,
  );

  globalThis.fetch = async () => new Response("denied", { status: 403 });
  await assert.rejects(
    discoverModels({ baseUrl: "https://models.example.test/v1" }),
    /HTTP 403/,
  );
});
