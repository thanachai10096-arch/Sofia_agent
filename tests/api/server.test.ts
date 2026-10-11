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
    apiKeys: { "test-token": [] },
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
