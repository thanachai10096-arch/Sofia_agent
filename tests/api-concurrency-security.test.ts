import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createSofiaApi } from "../src/api/server.js";
import type { AgentDependencies } from "../src/agent/types.js";
import type { SofiaBrain } from "../src/brain/executor.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function dependencies(run: () => Promise<unknown>): AgentDependencies {
  const fakeBrain = { runId: "api-concurrency", run } as unknown as SofiaBrain;
  return {
    provider: {} as AgentDependencies["provider"],
    router: { select: () => ({ id: "unused" }), markUnhealthy: () => undefined } as unknown as AgentDependencies["router"],
    reviewer: { review: async () => ({ approved: true, reason: "approved" }) },
    brainFactory: () => fakeBrain,
  };
}

async function withServer(
  deps: AgentDependencies,
  fn: (baseUrl: string) => Promise<void>,
) {
  const server = createSofiaApi(deps, {
    apiKeys: { "test-key": ["agent:run"] },
    maxConcurrentRunsPerKey: 1,
    requestTimeoutMs: 5_000,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const result = {
  completed: true,
  summary: "controlled test completion",
  state: "completed",
  changedFiles: [],
  verification: { passed: true, checks: ["test"] },
  usage: { steps: 1, toolCalls: 0, modelCalls: 1, reservedOrUsedTokens: 1, replans: 0 },
};

test("per-key concurrency limit applies to synchronous requests", async () => {
  const gate = deferred<unknown>();
  const started = deferred<void>();
  await withServer(dependencies(async () => { started.resolve(); return gate.promise; }), async (baseUrl) => {
    const first = fetch(`${baseUrl}/v1/agent/runs`, {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify({ task: "hold sync request" }),
    });
    await started.promise;

    const second = await fetch(`${baseUrl}/v1/agent/runs`, {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify({ task: "must be rate limited" }),
    });
    assert.equal(second.status, 429);
    assert.equal((await second.json() as { error: string }).error, "concurrency_limit");

    gate.resolve(result);
    assert.equal((await (await first).json() as { status: string }).status, "completed");
  });
});

test("per-key concurrency limit applies to SSE streaming requests", async () => {
  const gate = deferred<unknown>();
  const started = deferred<void>();
  await withServer(dependencies(async () => { started.resolve(); return gate.promise; }), async (baseUrl) => {
    const first = await fetch(`${baseUrl}/v1/agent/runs/stream`, {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify({ task: "hold streaming request" }),
    });
    assert.equal(first.status, 200);
    await started.promise;

    const second = await fetch(`${baseUrl}/v1/agent/runs/stream`, {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify({ task: "must be rate limited" }),
    });
    assert.equal(second.status, 429);
    assert.equal((await second.json() as { error: string }).error, "concurrency_limit");

    gate.resolve(result);
    const stream = await first.text();
    assert.match(stream, /"status":"completed"/);
  });
});
