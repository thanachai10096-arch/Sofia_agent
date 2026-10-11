import assert from "node:assert/strict";
import test from "node:test";
import { createSofiaApi } from "../../src/api/server.js";
import { SofiaClient } from "../../src/sdk/client.js";
import type { AgentDependencies } from "../../src/agent/types.js";
import type { ModelProvider, ModelRoute } from "../../src/models/types.js";
import { Reviewer } from "../../src/review/reviewer.js";

const route: ModelRoute = {
  id: "mobile-e2e-route",
  capabilities: ["coding", "reasoning", "tool-use"],
  costWeight: 1,
  latencyWeight: 1,
  qualityWeight: 10,
  healthy: true,
};

test("mobile SDK starts and polls a real local Sofia API run end-to-end", async (t) => {
  let providerCalls = 0;
  const provider: ModelProvider = {
    async generate() {
      providerCalls++;
      return { text: "MOBILE_SDK_E2E_OK" };
    },
  };
  const dependencies: AgentDependencies = {
    provider,
    router: { select: () => route, markUnhealthy() {} },
    reviewer: new Reviewer(),
  };
  const server = createSofiaApi(dependencies, {
    apiKeys: { "mobile-e2e-key": ["agent:run", "agent:read"] },
    requestTimeoutMs: 5_000,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let transientPollFailure = false;
  const client = new SofiaClient({
    apiKey: "mobile-e2e-key",
    baseUrl: "http://127.0.0.1:" + address.port,
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (!transientPollFailure && url.includes("/v1/agent/runs/") && init?.method !== "POST") {
        transientPollFailure = true;
        throw new TypeError("simulated mobile network handoff");
      }
      return fetch(input, init);
    },
  });

  const started = await client.start({ task: "Return the exact test token." });
  assert.ok(started.id);
  assert.equal(started.status, "queued");
  const finished = await client.waitForRun(started.id, {
    intervalMs: 100,
    maxIntervalMs: 200,
    timeoutMs: 5_000,
  });

  assert.equal(finished.status, "completed");
  assert.match(finished.result?.output ?? "", /MOBILE_SDK_E2E_OK/);
  assert.equal(transientPollFailure, true, "polling should recover after a simulated network handoff");
  assert.ok(providerCalls >= 1, "the local API should execute the provider");
});
