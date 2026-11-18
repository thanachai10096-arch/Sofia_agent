import assert from "node:assert/strict";
import test from "node:test";
import { createSofiaApi } from "./server.js";
import type { AutonomyJobStore } from "../autonomy/job-store.js";

test("autonomy queue infrastructure errors return a generic 503 without leaking internals", async () => {
  const store = {
    enqueue: async () => { throw new Error("postgres://internal-host:5432/private-db: password rejected"); },
  } as unknown as AutonomyJobStore;
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: { select: () => ({
      id: "api-autonomy-error-test",
      capabilities: ["fast"],
      costWeight: 1,
      latencyWeight: 1,
      qualityWeight: 1,
      healthy: true,
    }), markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
  }, {
    apiKeys: { "autonomy-test-key": ["autonomy:run"] },
    autonomyJobStore: store,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch("http://127.0.0.1:" + address.port + "/v1/autonomy/jobs", {
      method: "POST",
      headers: {
        authorization: "Bearer autonomy-test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ topic: "Investigate queue reliability" }),
    });
    assert.equal(response.status, 503);
    const payload = await response.json() as Record<string, unknown>;
    assert.deepEqual(payload, { error: "autonomy_queue_unavailable" });
    assert.equal(JSON.stringify(payload).includes("private-db"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
