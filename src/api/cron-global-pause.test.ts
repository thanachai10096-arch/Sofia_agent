import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentDependencies } from "../agent/types.js";
import { createSofiaApi } from "./server.js";

test("global cron pause and resume are authenticated and observable through the API", async () => {
  const previousStateDir = process.env.SOFIA_STATE_DIR;
  const stateDir = mkdtempSync(path.join(tmpdir(), "sofia-cron-api-"));
  process.env.SOFIA_STATE_DIR = stateDir;
  const deps = {
    provider: { generate: async () => ({ text: "unused" }) },
    router: { select: () => ({ id: "unused", capabilities: ["fast"], costWeight: 1, latencyWeight: 1, qualityWeight: 1, healthy: true }) },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
    jobRuntime: {
      submit: async () => { throw new Error("No scheduled work should be submitted in this test"); },
      get: async () => undefined,
      list: async () => [],
      cancel: async () => false,
      resume: async () => { throw new Error("unused"); },
    },
  } as unknown as AgentDependencies;
  const server = createSofiaApi(deps, {
    apiKeys: {
      "cron-reader": ["cron:read"],
      "cron-operator": ["cron:manage"],
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = "http://127.0.0.1:" + address.port;
  const request = (key: string, route: string, method = "GET", body?: unknown) => fetch(baseUrl + route, {
    method,
    headers: {
      authorization: "Bearer " + key,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  try {
    const initial = await request("cron-reader", "/v1/cron/status");
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), {
      paused: false,
      enabledSchedules: 0,
      activeExecutions: 0,
    });

    const denied = await request("cron-reader", "/v1/cron/pause", "POST", { reason: "maintenance" });
    assert.equal(denied.status, 403);

    const paused = await request("cron-operator", "/v1/cron/pause", "POST", { reason: "maintenance window" });
    assert.equal(paused.status, 200);
    assert.deepEqual(await paused.json(), {
      paused: true,
      pausedAt: (await request("cron-reader", "/v1/cron/status").then((response) => response.json()) as { pausedAt: string }).pausedAt,
      reason: "maintenance window",
    });

    const status = await request("cron-reader", "/v1/cron/status");
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { paused: boolean; pauseReason: string }).paused, true);

    const resumed = await request("cron-operator", "/v1/cron/resume", "POST");
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json() as { paused: boolean }).paused, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousStateDir === undefined) delete process.env.SOFIA_STATE_DIR;
    else process.env.SOFIA_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
