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

function makeDependencies(run: () => Promise<unknown>): AgentDependencies {
  const fakeBrain = {
    runId: "api-cancellation-race",
    run,
  } as unknown as SofiaBrain;
  return {
    provider: {} as AgentDependencies["provider"],
    router: { select: () => ({ id: "unused" }), markUnhealthy: () => undefined } as unknown as AgentDependencies["router"],
    reviewer: { review: async () => ({ approved: true, reason: "approved" }) },
    brainFactory: () => fakeBrain,
  };
}

async function withServer(
  deps: AgentDependencies,
  config: Parameters<typeof createSofiaApi>[1],
  fn: (baseUrl: string) => Promise<void>,
) {
  const server = createSofiaApi(deps, config);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("cancelled async run cannot be overwritten as completed by a late agent result", async () => {
  const gate = deferred<unknown>();
  await withServer(makeDependencies(() => gate.promise), {
    apiKeys: { "test-key": ["agent:run"] },
    requestTimeoutMs: 5_000,
  }, async (baseUrl) => {
    const started = await fetch(`${baseUrl}/v1/agent/runs`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
        "idempotency-key": "cancel-race",
      },
      body: JSON.stringify({ task: "wait for controlled completion", async: true }),
    });
    assert.equal(started.status, 202);
    const run = await started.json() as { id: string; status: string };

    const cancelled = await fetch(`${baseUrl}/v1/agent/runs/${run.id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer test-key" },
    });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json() as { status: string }).status, "cancelled");

    gate.resolve({
      completed: true,
      summary: "Late result must not win.",
      state: "completed",
      changedFiles: [],
      verification: { passed: true, checks: [] },
      usage: { steps: 1, toolCalls: 0, modelCalls: 1, reservedOrUsedTokens: 1, replans: 0 },
    });

    let finalStatus = "unknown";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await fetch(`${baseUrl}/v1/agent/runs/${run.id}`, {
        headers: { authorization: "Bearer test-key" },
      });
      const current = await response.json() as { status: string };
      finalStatus = current.status;
      if (finalStatus === "cancelled") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(finalStatus, "cancelled");
  });
});

test("API rejects malformed idempotency keys, invalid JSON, and oversized request bodies", async () => {
  await withServer(makeDependencies(async () => ({
    completed: true,
    summary: "ok",
    state: "completed",
    changedFiles: [],
    verification: { passed: true, checks: [] },
    usage: { steps: 1, toolCalls: 0, modelCalls: 1, reservedOrUsedTokens: 1, replans: 0 },
  })), {
    apiKeys: { "test-key": ["agent:run"] },
    maxBodyBytes: 256,
  }, async (baseUrl) => {
    const headers = {
      authorization: "Bearer test-key",
      "content-type": "application/json",
    };

    const invalidKey = await fetch(`${baseUrl}/v1/agent/runs`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": "k".repeat(129) },
      body: JSON.stringify({ task: "test", async: true }),
    });
    assert.equal(invalidKey.status, 400);
    assert.equal((await invalidKey.json() as { error: string }).error, "invalid_idempotency_key");

    const invalidJson = await fetch(`${baseUrl}/v1/agent/runs`, {
      method: "POST",
      headers,
      body: "{not-json",
    });
    assert.equal(invalidJson.status, 400);
    assert.equal((await invalidJson.json() as { error: string }).error, "invalid_json");

    const oversized = await fetch(`${baseUrl}/v1/agent/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ task: "x".repeat(400) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json() as { error: string }).error, "request_body_too_large");
  });
});
