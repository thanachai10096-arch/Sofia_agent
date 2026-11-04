import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSofiaApi } from "./server.js";
import type { JobRecord, JobRuntime } from "../brain/job-runtime.js";
import { MemorySessionStore } from "../session/store.js";
import { ModelRouter } from "../models/router.js";
import type { ModelRoute } from "../models/types.js";

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
    const sessionKeyFor = (key: string) => {
      const principalId = idFor(key);
      const apiSessionId = principalId + ":shared-client-session";
      return "principal:" + createHash("sha256").update(JSON.stringify([principalId, apiSessionId])).digest("hex");
    };
    assert.deepEqual(sessions.get(sessionKeyFor("key-one"))?.messages, [
      "user: first user's task",
      "assistant: Task completed.",
    ]);
    assert.deepEqual(sessions.get(sessionKeyFor("key-two"))?.messages, [
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


test("API job records and mutations are isolated by authenticated owner key", async () => {
  const records = new Map<string, JobRecord>();
  let resumeCalls = 0;
  let cancelCalls = 0;
  const jobRuntime: JobRuntime = {
    async submit(input) {
      const now = new Date().toISOString();
      const record: JobRecord = {
        id: "job-owner-isolation-1",
        status: "queued",
        createdAt: now,
        updatedAt: now,
        task: input.task,
        ownerKeyId: input.ownerKeyId,
      };
      records.set(record.id, record);
      return record;
    },
    async get(id) { return records.get(id); },
    async resume(id) {
      resumeCalls += 1;
      const record = records.get(id);
      if (!record) throw new Error("Unknown job");
      return record;
    },
    async cancel(id) {
      cancelCalls += 1;
      const record = records.get(id);
      if (!record) return false;
      record.status = "cancelled";
      return true;
    },
    async list() { return [...records.values()]; },
  };
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: new ModelRouter([route]),
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
    jobRuntime,
  }, {
    apiKeys: {
      "job-owner-one": ["agent:run", "agent:read"],
      "job-owner-two": ["agent:run", "agent:read"],
    },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = "http://127.0.0.1:" + address.port;
  const request = (key: string, path: string, method = "GET", body?: unknown) =>
    fetch(baseUrl + path, {
      method,
      headers: {
        authorization: "Bearer " + key,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  try {
    const created = await request("job-owner-one", "/v1/jobs", "POST", { task: "private job" });
    assert.equal(created.status, 202);
    const job = await created.json() as JobRecord;
    assert.equal(job.ownerKeyId, createHash("sha256").update("job-owner-one").digest("hex").slice(0, 32));

    assert.equal((await request("job-owner-one", "/v1/jobs/" + job.id)).status, 200);
    assert.equal((await request("job-owner-two", "/v1/jobs/" + job.id)).status, 404);
    assert.equal((await request("job-owner-two", "/v1/jobs/" + job.id + "/resume", "POST")).status, 404);
    assert.equal((await request("job-owner-two", "/v1/jobs/" + job.id + "/cancel", "POST")).status, 404);
    assert.equal(resumeCalls, 0, "foreign owner must not reach resume()");
    assert.equal(cancelCalls, 0, "foreign owner must not reach cancel()");
    assert.equal((await request("job-owner-two", "/v1/jobs")).status, 200);
    const foreignList = await (await request("job-owner-two", "/v1/jobs")).json() as { jobs: JobRecord[] };
    assert.deepEqual(foreignList.jobs, []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
