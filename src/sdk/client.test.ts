import assert from "node:assert/strict";
import test from "node:test";
import { SofiaApiError, SofiaClient } from "./client.js";

const response = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

test("mobile async start returns a durable run ID and sends async=true", async () => {
  let request: RequestInit | undefined;
  const client = new SofiaClient({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    fetchImpl: async (_input, init) => {
      request = init;
      return response(202, { id: "run-123", status: "queued" });
    },
  });

  const result = await client.start({ task: "inspect the project" });
  assert.deepEqual(result, { id: "run-123", status: "queued" });
  assert.equal(request?.method, "POST");
  assert.equal((request?.headers as Record<string, string>).authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(String(request?.body)), { task: "inspect the project", async: true });
});

test("mobile polling retries transient server errors with bounded backoff", async () => {
  let calls = 0;
  const client = new SofiaClient({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return response(503, { error: "provider temporarily unavailable" });
      if (calls === 2) return response(200, { id: "job-1", status: "running" });
      return response(200, { id: "job-1", status: "completed", result: { output: "done", kind: "text", steps: 2 } });
    },
  });

  const result = await client.waitForJob("job-1", { intervalMs: 100, maxIntervalMs: 100, timeoutMs: 2_000 });
  assert.equal(result.status, "completed");
  assert.equal(calls, 3);
});

test("mobile polling stops promptly when the caller aborts", async () => {
  const controller = new AbortController();
  const client = new SofiaClient({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    fetchImpl: async () => response(200, { id: "job-1", status: "running" }),
  });
  const waiting = client.waitForJob("job-1", {
    intervalMs: 500,
    timeoutMs: 5_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(new Error("user navigated away")), 25);
  await assert.rejects(waiting, /user navigated away/);
});

test("SDK surfaces structured API errors and refuses insecure remote endpoints", async () => {
  const client = new SofiaClient({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    fetchImpl: async () => response(403, { error: "forbidden" }),
  });
  await assert.rejects(client.start({ task: "no access" }), (error: unknown) => {
    assert.ok(error instanceof SofiaApiError);
    assert.equal(error.status, 403);
    assert.equal(error.message, "forbidden");
    return true;
  });
  assert.throws(() => new SofiaClient({ apiKey: "test-key", baseUrl: "http://api.example.test" }), /HTTPS/);
});

test("SDK rejects API URLs with embedded credentials, query strings, or fragments", () => {
  assert.throws(
    () => new SofiaClient({ apiKey: "test-key", baseUrl: "https://user:pass@api.example.test" }),
    /embedded credentials/,
  );
  assert.throws(
    () => new SofiaClient({ apiKey: "test-key", baseUrl: "https://api.example.test?token=unexpected" }),
    /query string or fragment/,
  );
  assert.throws(
    () => new SofiaClient({ apiKey: "test-key", baseUrl: "https://api.example.test/#route" }),
    /query string or fragment/,
  );
});

test("SDK permits HTTP only for loopback development endpoints", () => {
  assert.doesNotThrow(() => new SofiaClient({ apiKey: "test-key", baseUrl: "http://localhost:3000" }));
  assert.doesNotThrow(() => new SofiaClient({ apiKey: "test-key", baseUrl: "http://127.0.0.1:3000" }));
  assert.throws(() => new SofiaClient({ apiKey: "test-key", baseUrl: "http://api.example.test" }), /HTTPS/);
});

test("SDK aborts stalled mobile requests at the configured timeout", async () => {
  const client = new SofiaClient({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    requestTimeoutMs: 20,
    fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error("missing timeout signal"));
      const fail = () => reject(signal.reason ?? new Error("aborted"));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    }),
  });
  await assert.rejects(client.start({ task: "must not hang forever" }), /timed out/i);
});

test("async start forwards a validated idempotency key", async () => {
  let request: RequestInit | undefined;
  const client = new SofiaClient({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    fetchImpl: async (_input, init) => {
      request = init;
      return response(202, { id: "run-idempotent", status: "queued" });
    },
  });

  await client.start({ task: "run once" }, undefined, { idempotencyKey: "chat_abc123" });
  assert.equal((request?.headers as Record<string, string>)["idempotency-key"], "chat_abc123");
  await assert.rejects(
    client.start({ task: "bad key" }, undefined, { idempotencyKey: "invalid\\nkey" }),
    /control characters/,
  );
});
