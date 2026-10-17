import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileRunRecordStore } from "../../src/api/run-record-store.js";
import test from "node:test";
import { createSofiaApi } from "../../src/api/server.js";
import type { AgentDependencies } from "../../src/agent/types.js";
import type { SofiaApiConfig } from "../../src/api/types.js";
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

async function startApi(provider: ModelProvider, overrides: Partial<SofiaApiConfig> = {}) {
  const server = createSofiaApi(dependencies(provider), {
    apiKeys: { "test-token": ["agent:run"] },
    allowedOrigins: ["https://app.example"],
    requestTimeoutMs: 5_000,
    ...overrides,
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


test("API routes match pathname when query parameters are present", async (t) => {
  const provider: ModelProvider = { async generate() { return { text: "unused" }; } };
  const { server, url } = await startApi(provider);
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const response = await fetch(url + "/v1/usage?view=summary", {
    headers: { authorization: "Bearer test-token" },
  });
  assert.equal(response.status, 200);
});

test("API concurrency limit applies to async, sync, and SSE run modes", async (t) => {
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const provider: ModelProvider = {
    async generate() {
      markStarted();
      await blocked;
      return { text: "done" };
    },
  };
  const { server, url } = await startApi(provider, { maxConcurrentRunsPerKey: 1 });
  t.after(async () => {
    release();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
  const first = await fetch(url + "/v1/agent/runs", {
    method: "POST", headers, body: JSON.stringify({ task: "first run", async: true }),
  });
  assert.equal(first.status, 202);
  await started;

  const sync = await fetch(url + "/v1/agent/runs", {
    method: "POST", headers, body: JSON.stringify({ task: "second run" }),
  });
  assert.equal(sync.status, 429);
  assert.deepEqual(await sync.json(), { error: "concurrency_limit", retryAfterMs: 2000 });

  const stream = await fetch(url + "/v1/agent/runs/stream", {
    method: "POST", headers, body: JSON.stringify({ task: "third run" }),
  });
  assert.equal(stream.status, 429);
  assert.deepEqual(await stream.json(), { error: "concurrency_limit", retryAfterMs: 2000 });
  release();
});


test("SSE reports request timeout separately from user cancellation", async (t) => {
  const provider: ModelProvider = {
    generate(_request, _route, options) {
      const signal = options?.signal;
      assert.ok(signal);
      return new Promise((_, reject) => {
        const onAbort = () => reject(new Error("provider aborted"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
  const { server, url } = await startApi(provider, { requestTimeoutMs: 50 });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const response = await streamRequest(url);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /"status":"failed"/);
  assert.match(body, /Run timed out\./);
  assert.doesNotMatch(body, /Run cancelled\./);
});


test("API restores idempotency keys from durable run records after restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sofia-idempotency-restart-"));
  let providerCalls = 0;
  const provider: ModelProvider = {
    async generate() {
      providerCalls += 1;
      return { text: "durable result" };
    },
  };
  let currentServer: ReturnType<typeof createSofiaApi> | undefined;
  const closeCurrent = async () => {
    if (!currentServer) return;
    const server = currentServer;
    currentServer = undefined;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  try {
    const store = new FileRunRecordStore(directory);
    let instance = await startApi(provider, { runStore: store });
    currentServer = instance.server;
    const headers = {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      "idempotency-key": "retry-after-restart",
    };
    const body = JSON.stringify({ task: "perform this task once", async: true });
    const created = await fetch(instance.url + "/v1/agent/runs", { method: "POST", headers, body });
    assert.equal(created.status, 202);
    const createdRun = await created.json() as { id: string };
    let status = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(instance.url + "/v1/agent/runs/" + createdRun.id, {
        headers: { authorization: "Bearer test-token" },
      });
      status = (await response.json() as { status: string }).status;
      if (status === "completed" || status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(status, "completed");
    const callsAfterFirstRun = providerCalls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    await closeCurrent();

    instance = await startApi(provider, { runStore: new FileRunRecordStore(directory) });
    currentServer = instance.server;
    const retried = await fetch(instance.url + "/v1/agent/runs", { method: "POST", headers, body });
    assert.equal(retried.status, 200);
    const retriedRun = await retried.json() as { id: string };
    assert.equal(retriedRun.id, createdRun.id);
    assert.equal(providerCalls, callsAfterFirstRun, "retry must not execute the task again");
  } finally {
    await closeCurrent();
    await rm(directory, { recursive: true, force: true });
  }
});


test("API does not acknowledge an async run when durable persistence fails", async (t) => {
  let providerCalls = 0;
  const provider: ModelProvider = {
    async generate() {
      providerCalls += 1;
      return { text: "must not run" };
    },
  };
  const runStore = {
    loadAllSync: () => [],
    async save() { throw new Error("synthetic store outage"); },
    async remove() {},
  };
  const { server, url } = await startApi(provider, { runStore });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const response = await fetch(url + "/v1/agent/runs", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      "idempotency-key": "durability-failure",
    },
    body: JSON.stringify({ task: "must not be accepted", async: true }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "run_persistence_unavailable" });
  assert.equal(providerCalls, 0);
});
