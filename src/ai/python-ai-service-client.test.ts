import test from "node:test";
import assert from "node:assert/strict";
import { PythonAiServiceClient, PythonAiServiceError } from "./python-ai-service-client.js";

const token = "test-token-with-at-least-24-characters";
function client(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new PythonAiServiceClient({
    baseUrl: "http://127.0.0.1:8091", token, fetchImpl, ...overrides,
  } as ConstructorParameters<typeof PythonAiServiceClient>[0]);
}
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("embeddings sends authenticated bounded request and validates dimensions", async () => {
  let request: RequestInit | undefined;
  const api = client(async (_input, init) => {
    request = init;
    return jsonResponse({ model: "fake-embedder", dimensions: 2, embeddings: [[0.1, 0.2], [0.3, 0.4]] });
  });
  const result = await api.embed(["first", "second"]);
  assert.deepEqual(result.embeddings, [[0.1, 0.2], [0.3, 0.4]]);
  assert.equal(new Headers(request?.headers).get("authorization"), "Bearer " + token);
  assert.equal(new Headers(request?.headers).get("x-request-id")?.length, 36);
  assert.equal(request?.redirect, "error");
});

test("rerank validates unique in-range indexes and finite scores", async () => {
  const api = client(async () => jsonResponse({
    model: "fake-reranker", results: [{ index: 1, score: 0.9 }, { index: 0, score: 0.2 }],
  }));
  assert.deepEqual((await api.rerank("query", ["a", "b"])).results, [
    { index: 1, score: 0.9 }, { index: 0, score: 0.2 },
  ]);
});

test("rejects invalid and oversized inputs before network access", async () => {
  let calls = 0;
  const api = client(async () => { calls += 1; return jsonResponse({}); });
  await assert.rejects(api.embed([" "]), (error: unknown) => error instanceof PythonAiServiceError && error.code === "REQUEST_INVALID");
  await assert.rejects(api.embed(Array.from({ length: 65 }, () => "x")), (error: unknown) => error instanceof PythonAiServiceError && error.code === "REQUEST_INVALID");
  await assert.rejects(api.rerank("query", ["x".repeat(20_001)]), (error: unknown) => error instanceof PythonAiServiceError && error.code === "REQUEST_INVALID");
  assert.equal(calls, 0);
});

test("rejects unsafe URLs and weak tokens", () => {
  for (const baseUrl of ["http://example.com", "https://user:pass@example.com", "https://ai.example.com/path"]) {
    assert.throws(() => new PythonAiServiceClient({ baseUrl, token }), (error: unknown) => error instanceof PythonAiServiceError && error.code === "CONFIGURATION");
  }
  assert.throws(() => new PythonAiServiceClient({ baseUrl: "https://ai.example.com", token: "short" }),
    (error: unknown) => error instanceof PythonAiServiceError && error.code === "CONFIGURATION");
});

test("rejects malformed embedding dimensions and non-finite numbers", async () => {
  const api = client(async () => jsonResponse({ model: "fake", dimensions: 2, embeddings: [[0.1, null]] }));
  await assert.rejects(api.embed(["one"]), (error: unknown) => error instanceof PythonAiServiceError && error.code === "RESPONSE_INVALID");
});

test("rejects malformed rerank duplicate indexes", async () => {
  const api = client(async () => jsonResponse({
    model: "fake", results: [{ index: 0, score: 0.1 }, { index: 0, score: 0.2 }],
  }));
  await assert.rejects(api.rerank("q", ["a", "b"]), (error: unknown) => error instanceof PythonAiServiceError && error.code === "RESPONSE_INVALID");
});

test("does not expose remote error bodies", async () => {
  const api = client(async () => new Response("secret internal traceback", { status: 503, headers: { "content-type": "text/plain" } }));
  await assert.rejects(api.embed(["one"]), (error: unknown) =>
    error instanceof PythonAiServiceError && error.code === "HTTP" && !error.message.includes("traceback"));
});

test("enforces response byte limit", async () => {
  const api = client(async () => jsonResponse({ model: "fake", dimensions: 1, embeddings: [[0.1]] }), { maxResponseBytes: 8 });
  await assert.rejects(api.embed(["one"]), (error: unknown) => error instanceof PythonAiServiceError && error.code === "RESPONSE_INVALID");
});

test("distinguishes timeout from caller cancellation", async () => {
  const slowFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
  const timeoutClient = client(slowFetch, { timeoutMs: 10 });
  await assert.rejects(timeoutClient.embed(["one"]), (error: unknown) => error instanceof PythonAiServiceError && error.code === "TIMEOUT");
  const controller = new AbortController();
  const cancelClient = client(slowFetch, { timeoutMs: 1_000 });
  const pending = cancelClient.embed(["one"], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof PythonAiServiceError && error.code === "ABORTED");
});

test("never retries a failed model request implicitly", async () => {
  let calls = 0;
  const api = client(async () => { calls += 1; return new Response("unavailable", { status: 503 }); });
  await assert.rejects(api.embed(["one"]));
  assert.equal(calls, 1);
});
