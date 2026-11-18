import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSofiaApi } from "./server.js";
import { MemorySessionStore } from "../session/store.js";
import { ModelRouter } from "../models/router.js";
import type { ModelRoute } from "../models/types.js";
import { FileAutonomyJobStore } from "../autonomy/job-store.js";

const route: ModelRoute = {
  id: "api-session-test",
  capabilities: ["fast"],
  costWeight: 1,
  latencyWeight: 1,
  qualityWeight: 1,
  healthy: true,
};

test("API sessions are persisted and scoped to the authenticated API key", async () => {
  const sessions = new MemorySessionStore();
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "Task completed." }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
    sessionStore: sessions,
  }, {
    apiKeys: {
      "key-one": ["agent:run", "agent:read"],
      "key-two": ["agent:run", "agent:read"],
    },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const startAndWait = async (apiKey: string, task: string) => {
    const started = await fetch(`${baseUrl}/v1/agent/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ task, sessionId: "shared-client-session", async: true }),
    });
    assert.equal(started.status, 202);
    const initial = await started.json() as { id: string };
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${baseUrl}/v1/agent/runs/${initial.id}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(response.status, 200);
      const run = await response.json() as { status: string };
      if (run.status === "completed") return;
      if (run.status === "failed" || run.status === "cancelled") {
        throw new Error(`API run ended with status ${run.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("API run did not finish within the test deadline");
  };

  try {
    await startAndWait("key-one", "first user's task");
    await startAndWait("key-two", "second user's task");

    const idFor = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);
    assert.deepEqual(sessions.get(`${idFor("key-one")}:shared-client-session`)?.messages, [
      "user: first user's task",
      "assistant: Task completed.",
    ]);
    assert.deepEqual(sessions.get(`${idFor("key-two")}:shared-client-session`)?.messages, [
      "user: second user's task",
      "assistant: Task completed.",
    ]);
    assert.equal(sessions.get("shared-client-session"), undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("API lists configured models and honors an explicit model route", async () => {
  const routes: ModelRoute[] = [
    { id: "fast", model: "vendor/fast-model", capabilities: ["fast"], costWeight: 1, latencyWeight: 1, qualityWeight: 5, healthy: true },
    { id: "coding", model: "vendor/coding-model", capabilities: ["coding", "tool-use", "reasoning"], costWeight: 2, latencyWeight: 2, qualityWeight: 8, healthy: true },
  ];
  const router = new ModelRouter(routes);
  const selected: string[] = [];
  const server = createSofiaApi({
    provider: {
      generate: async (_request, route) => {
        selected.push(route.id);
        return { text: "Task completed." };
      },
    },
    router,
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
  }, {
    apiKeys: { "model-key": ["agent:run", "agent:read"] },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = "http://127.0.0.1:" + address.port;
  try {
    const listed = await fetch(baseUrl + "/v1/models", {
      headers: { authorization: "Bearer model-key" },
    });
    assert.equal(listed.status, 200);
    const payload = await listed.json() as { automaticSelection: boolean; models: Array<{ id: string; model: string }> };
    assert.equal(payload.automaticSelection, true);
    assert.deepEqual(payload.models.map((model) => ({ id: model.id, model: model.model })), [
      { id: "fast", model: "vendor/fast-model" },
      { id: "coding", model: "vendor/coding-model" },
    ]);

    const response = await fetch(baseUrl + "/v1/agent/runs", {
      method: "POST",
      headers: { authorization: "Bearer model-key", "content-type": "application/json" },
      body: JSON.stringify({ task: "do a general task", modelRouteId: "coding" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(selected, ["coding"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("API rejects unknown model routes before starting a run", async () => {
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "Should not run." }) },
    router: new ModelRouter([route]),
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
  }, { apiKeys: { "model-key": ["agent:run"] } });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch("http://127.0.0.1:" + address.port + "/v1/agent/runs", {
      method: "POST",
      headers: { authorization: "Bearer model-key", "content-type": "application/json" },
      body: JSON.stringify({ task: "do a task", modelRouteId: "not-configured" }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_model_route" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("autonomy queue API derives tenant identity from auth and supports idempotent enqueue", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-api-autonomy-"));
  const queue = new FileAutonomyJobStore("api-test", root);
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
  }, {
    apiKeys: {
      "autonomy-key-one": ["autonomy:run", "autonomy:read"],
      "autonomy-key-two": ["autonomy:run", "autonomy:read"],
      "read-only": ["autonomy:read"],
    },
    autonomyJobStore: queue,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  try {
    const enqueue = () => fetch(base + "/v1/autonomy/jobs", {
      method: "POST",
      headers: {
        authorization: "Bearer autonomy-key-one",
        "content-type": "application/json",
        "idempotency-key": "same-request",
      },
      body: JSON.stringify({ topic: "Improve worker reliability", principalId: "attacker-controlled" }),
    });
    const rejected = await enqueue();
    assert.equal(rejected.status, 400);
    const created = await fetch(base + "/v1/autonomy/jobs", {
      method: "POST",
      headers: {
        authorization: "Bearer autonomy-key-one",
        "content-type": "application/json",
        "idempotency-key": "same-request",
      },
      body: JSON.stringify({ topic: "Improve worker reliability", context: "Focus on retries" }),
    });
    assert.equal(created.status, 202);
    const first = await created.json() as { job: { id: string; payload: { topic: string }; principalId?: string } };
    assert.equal(first.job.payload.topic, "Improve worker reliability");
    assert.equal(first.job.principalId, undefined);

    const repeated = await fetch(base + "/v1/autonomy/jobs", {
      method: "POST",
      headers: {
        authorization: "Bearer autonomy-key-one",
        "content-type": "application/json",
        "idempotency-key": "same-request",
      },
      body: JSON.stringify({ topic: "Improve worker reliability", context: "Focus on retries" }),
    });
    assert.equal(repeated.status, 202);
    const second = await repeated.json() as { job: { id: string } };
    assert.equal(second.job.id, first.job.id);

    const conflict = await fetch(base + "/v1/autonomy/jobs", {
      method: "POST",
      headers: {
        authorization: "Bearer autonomy-key-one",
        "content-type": "application/json",
        "idempotency-key": "same-request",
      },
      body: JSON.stringify({ topic: "A different research question" }),
    });
    assert.equal(conflict.status, 409);

    const listed = await fetch(base + "/v1/autonomy/jobs", {
      headers: { authorization: "Bearer autonomy-key-one" },
    });
    assert.equal(listed.status, 200);
    const list = await listed.json() as { jobs: Array<{ id: string }> };
    assert.equal(list.jobs.length, 1);

    const crossTenant = await fetch(base + "/v1/autonomy/jobs/" + first.job.id, {
      headers: { authorization: "Bearer autonomy-key-two" },
    });
    assert.equal(crossTenant.status, 404);

    const cancelled = await fetch(base + "/v1/autonomy/jobs/" + first.job.id, {
      method: "DELETE",
      headers: { authorization: "Bearer autonomy-key-one" },
    });
    assert.equal(cancelled.status, 200);
    const cancelledBody = await cancelled.json() as { job: { status: string } };
    assert.equal(cancelledBody.job.status, "cancelled");

    const forbidden = await fetch(base + "/v1/autonomy/jobs", {
      method: "POST",
      headers: { authorization: "Bearer read-only", "content-type": "application/json" },
      body: JSON.stringify({ topic: "This must not enqueue" }),
    });
    assert.equal(forbidden.status, 403);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
