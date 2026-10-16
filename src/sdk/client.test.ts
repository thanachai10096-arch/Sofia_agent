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


test("SDK lists and searches personal memory with URL-encoded queries", async () => {
  const requests: string[] = [];
  const client = new SofiaClient({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    fetchImpl: async (input, init) => {
      requests.push(String(input));
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer test-key");
      return response(200, { entries: [{ id: "memory-1", kind: "preference", content: "Prefers Thai", source: "explicit-user-request", confidence: 1, createdAt: "2026-10-14T00:00:00.000Z", updatedAt: "2026-10-14T00:00:00.000Z", uses: 0 }] });
    },
  });
  const listed = await client.listMemory();
  assert.equal(listed.entries[0]?.content, "Prefers Thai");
  const searched = await client.searchMemory("ไทย & concise");
  assert.equal(searched.entries.length, 1);
  assert.match(requests[0] ?? "", /\/v1\/memory$/);
  assert.match(requests[1] ?? "", /q=%E0%B9%84%E0%B8%97%E0%B8%A2\+%26\+concise/);
});

test("SDK deletes one memory and clears the principal memory namespace", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const client = new SofiaClient({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? "GET" });
      return response(200, init?.method === "DELETE" && String(input).includes("/memory/") ? { ok: true, deleted: true } : { ok: true, cleared: true });
    },
  });
  assert.deepEqual(await client.deleteMemory("entry/with spaces"), { ok: true, deleted: true });
  assert.deepEqual(await client.clearMemory(), { ok: true, cleared: true });
  assert.match(requests[0]?.url ?? "", /\/v1\/memory\/entry%2Fwith%20spaces$/);
  assert.equal(requests[0]?.method, "DELETE");
  assert.equal(requests[1]?.url, "https://api.example.test/v1/memory");
  assert.equal(requests[1]?.method, "DELETE");
});


test("SDK creates, lists, reads, runs, and deletes workflow plans using authenticated routes", async () => {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const plan = { id: "workflow-1", title: "Example", status: "draft", steps: [] };
  const client = new SofiaClient({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    fetchImpl: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.endsWith("/run")) return response(200, { plan: { ...plan, status: "completed" }, executed: 1, waitingForApproval: false });
      if (url.endsWith("/cancel")) return response(202, { ok: true, cancelRequested: true, workflowId: "workflow/a" });
      if (method === "POST" && url.endsWith("/v1/workflows")) return response(201, { workflow: plan });
      if (method === "GET" && url.endsWith("/v1/workflows")) return response(200, { workflows: [plan] });
      if (method === "DELETE") return response(200, { ok: true, deleted: true });
      return response(200, { workflow: plan });
    },
  });
  const created = await client.createWorkflow("Example", [
    { id: "step", title: "Step", description: "Inspect", idempotent: true },
  ]);
  assert.equal(created.workflow.id, "workflow-1");
  assert.equal((await client.listWorkflows()).workflows.length, 1);
  assert.equal((await client.getWorkflow("workflow/a")).workflow.title, "Example");
  assert.equal((await client.runWorkflow("workflow/a")).plan.status, "completed");
  assert.deepEqual(await client.deleteWorkflow("workflow/a"), { ok: true, deleted: true });
  assert.deepEqual(await client.cancelWorkflow("workflow/a"), { ok: true, cancelRequested: true, workflowId: "workflow/a" });
  assert.equal(requests[0]?.method, "POST");
  assert.deepEqual(requests[0]?.body, {
    title: "Example",
    steps: [{ id: "step", title: "Step", description: "Inspect", idempotent: true }],
  });
  assert.match(requests[2]?.url ?? "", /workflow%2Fa$/);
  assert.match(requests[3]?.url ?? "", /workflow%2Fa\/run$/);
  assert.match(requests[5]?.url ?? "", /workflow%2Fa\/cancel$/);
  assert.ok(requests.every((request) => request.url.startsWith("https://api.example.test/v1/workflows")));
});
