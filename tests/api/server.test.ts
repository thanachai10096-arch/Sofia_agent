import assert from "node:assert/strict";
import test from "node:test";
import { createSofiaApi } from "../../src/api/server.js";
import type { AgentDependencies } from "../../src/agent/types.js";
import type { ModelProvider, ModelRoute } from "../../src/models/types.js";

const route: ModelRoute = {
  id: "test-route",
  capabilities: ["coding", "reasoning", "tool-use"],
  costWeight: 1,
  latencyWeight: 1,
  qualityWeight: 10,
  healthy: true,
};

function dependencies(provider: ModelProvider): AgentDependencies {
  return {
    provider,
    router: { select: () => route, markUnhealthy() {} },
    reviewer: { async review() { return { approved: true, reason: "test review passed" }; } },
  };
}

async function startApi(provider: ModelProvider) {
  const server = createSofiaApi(dependencies(provider), {
    apiKeys: { "test-token": ["agent:run"] },
    allowedOrigins: ["https://app.example"],
    requestTimeoutMs: 5_000,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

function streamRequest(url: string, signal?: AbortSignal) {
  return fetch(`${url}/v1/agent/runs/stream`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      origin: "https://app.example",
      "content-type": "application/json",
    },
    body: JSON.stringify({ task: "return a short result" }),
    ...(signal ? { signal } : {}),
  });
}

test("SSE endpoint emits correctly delimited events", async (t) => {
  const provider: ModelProvider = {
    async generate() {
      return { text: "verified result" };
    },
  };
  const { server, url } = await startApi(provider);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const response = await streamRequest(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const body = await response.text();

  assert.ok(body.includes("\n\n"), "SSE events must end with real blank-line delimiters");
  assert.ok(body.includes('"type":"done"'), "stream should end with a done event");
  assert.ok(body.split("\n\n").filter((frame) => frame.startsWith("data: ")).length >= 4);
});

test("SSE client disconnect aborts the in-flight model request", async (t) => {
  let markStarted!: () => void;
  let markAborted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
  const provider: ModelProvider = {
    generate(_request, _route, options) {
      const signal = options?.signal;
      assert.ok(signal, "agent must pass cancellation to the provider");
      markStarted();
      return new Promise((_, reject) => {
        const onAbort = () => {
          markAborted();
          reject(new Error("provider aborted"));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
  const { server, url } = await startApi(provider);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const client = new AbortController();
  const response = await streamRequest(url, client.signal);
  assert.equal(response.status, 200);
  await started;
  client.abort();

  await Promise.race([
    aborted,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("provider did not receive disconnect cancellation")), 2_000)),
  ]);
});


test("job API enforces owner isolation for reads, resume, cancel, and list", async (t) => {
  const provider: ModelProvider = { async generate() { return { text: "unused" }; } };
  const job: { current?: import("../../src/brain/job-runtime.js").JobRecord; resumeCalls: number; cancelCalls: number } = {
    resumeCalls: 0,
    cancelCalls: 0,
  };
  const jobRuntime = {
    async submit(input: { task: string; ownerKeyId?: string }) {
      job.current = {
        id: "owned-job",
        status: "failed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        task: input.task,
        ownerKeyId: input.ownerKeyId,
      };
      return { ...job.current };
    },
    async get(id: string) { return job.current && id === job.current.id ? { ...job.current } : undefined; },
    async list() { return job.current ? [{ ...job.current }] : []; },
    async resume() { job.resumeCalls += 1; return { ...job.current! }; },
    async cancel() { job.cancelCalls += 1; return true; },
  };
  const server = createSofiaApi(
    { ...dependencies(provider), jobRuntime: jobRuntime as unknown as import("../../src/brain/job-runtime.js").JobRuntime },
    { apiKeys: { "owner-token": ["agent:run"], "other-token": ["agent:run"] } },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (token: string, path: string, init: RequestInit = {}) =>
    fetch(base + path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });

  const created = await request("owner-token", "/v1/jobs", {
    method: "POST",
    body: JSON.stringify({ task: "owner-only job" }),
  });
  assert.equal(created.status, 202);
  assert.equal((await request("owner-token", "/v1/jobs/owned-job")).status, 200);

  assert.equal((await request("other-token", "/v1/jobs/owned-job")).status, 404);
  assert.equal((await request("other-token", "/v1/jobs/owned-job/resume", { method: "POST" })).status, 404);
  assert.equal((await request("other-token", "/v1/jobs/owned-job/cancel", { method: "POST" })).status, 404);
  const listed = await request("other-token", "/v1/jobs");
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json() as { jobs: unknown[] }).jobs, []);
  assert.equal(job.resumeCalls, 0, "unauthorized caller must not invoke resume");
  assert.equal(job.cancelCalls, 0, "unauthorized caller must not invoke cancel");
});


test("CORS preflight allows the idempotency-key header used by browser clients", async (t) => {
  const provider: ModelProvider = { async generate() { return { text: "ok" }; } };
  const { server, url } = await startApi(provider);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const response = await fetch(url + "/v1/agent/runs", {
    method: "OPTIONS",
    headers: {
      origin: "https://app.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type,idempotency-key",
    },
  });
  assert.equal(response.status, 204);
  assert.match(response.headers.get("access-control-allow-headers") ?? "", /idempotency-key/i);
});

test("async API rejects an idempotency key reused with a different request", async (t) => {
  const provider: ModelProvider = {
    async generate() {
      return { text: "ok" };
    },
  };
  const { server, url } = await startApi(provider);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const post = (task: string, sessionId?: string) => fetch(url + "/v1/agent/runs", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      "idempotency-key": "same-key",
    },
    body: JSON.stringify({ task, async: true, ...(sessionId ? { sessionId } : {}) }),
  });

  const first = await post("first task");
  assert.equal(first.status, 202);
  const firstBody = await first.json() as { id: string };

  const duplicate = await post("first task");
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json() as { id: string }).id, firstBody.id);

  const sessionMismatch = await post("first task", "different-session");
  assert.equal(sessionMismatch.status, 409, "sessionId is part of request identity");

  const mismatch = await post("different task");
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json() as { error: string }).error, "idempotency_key_reused");
});
