import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSofiaApi } from "./server.js";
import { MemorySessionStore, scopedSessionId } from "../session/store.js";
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

    const idFor = (key: string) => scopedSessionId(createHash("sha256").update(key).digest("hex").slice(0, 32), "shared-client-session");
    assert.deepEqual(sessions.get(idFor("key-one"))?.messages, [
      "user: first user's task",
      "assistant: Task completed.",
    ]);
    assert.deepEqual(sessions.get(idFor("key-two"))?.messages, [
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
    { id: "fast", providerId: "private-fast-provider", model: "vendor/fast-model", capabilities: ["fast"], costWeight: 1, latencyWeight: 1, qualityWeight: 5, healthy: true, featureSupport: { toolCalling: false, vision: false, structuredOutput: true, contextWindow: 32_000 } },
    { id: "coding", providerId: "private-coding-provider", model: "vendor/coding-model", capabilities: ["coding", "tool-use", "reasoning"], costWeight: 2, latencyWeight: 2, qualityWeight: 8, healthy: true, featureSupport: { toolCalling: true, vision: true, structuredOutput: true, contextWindow: 128_000 } },
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
    const payload = await listed.json() as { automaticSelection: boolean; models: Array<{ id: string; model: string; featureSupport?: { toolCalling?: boolean; vision?: boolean; structuredOutput?: boolean; contextWindow?: number } }> };
    assert.equal(payload.automaticSelection, true);
    assert.deepEqual(Object.keys(payload.models[0] ?? {}).sort(), [
      "capabilities", "featureSupport", "healthy", "id", "model",
    ]);
    const serializedModels = JSON.stringify(payload);
    assert.equal(serializedModels.includes("private-fast-provider"), false);
    assert.equal(serializedModels.includes("private-coding-provider"), false);
    assert.equal(serializedModels.includes("model-key"), false);
    assert.deepEqual(payload.models.map((model) => ({ id: model.id, model: model.model })), [
      { id: "fast", model: "vendor/fast-model" },
      { id: "coding", model: "vendor/coding-model" },
    ]);
    assert.deepEqual(payload.models.map((model) => model.featureSupport), [
      { toolCalling: false, vision: false, structuredOutput: true, contextWindow: 32_000 },
      { toolCalling: true, vision: true, structuredOutput: true, contextWindow: 128_000 },
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


test("job API never exposes or mutates another API key owner's job", async () => {
  const records = new Map<string, { id: string; status: "queued" | "completed"; ownerKeyId: string; task: string }>();
  const calls: Array<{ operation: string; owner?: string }> = [];
  const jobRuntime = {
    submit: async (input: { task: string; ownerKeyId?: string }) => {
      const record = { id: "job-owner-a-0001", status: "queued" as const, ownerKeyId: input.ownerKeyId!, task: input.task };
      records.set(record.id, record);
      calls.push({ operation: "submit", owner: input.ownerKeyId });
      return record;
    },
    get: async (id: string, owner?: string) => {
      calls.push({ operation: "get", owner });
      const record = records.get(id);
      return record?.ownerKeyId === owner ? record : undefined;
    },
    list: async (owner?: string) => {
      calls.push({ operation: "list", owner });
      return [...records.values()].filter((record) => record.ownerKeyId === owner);
    },
    resume: async (id: string, _signal?: AbortSignal, owner?: string) => {
      calls.push({ operation: "resume", owner });
      const record = records.get(id);
      if (!record || record.ownerKeyId !== owner) throw new Error("Unknown job");
      return record;
    },
    cancel: async (id: string, owner?: string) => {
      calls.push({ operation: "cancel", owner });
      const record = records.get(id);
      if (!record || record.ownerKeyId !== owner) return false;
      record.status = "completed";
      return true;
    },
  };
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: new ModelRouter([route]),
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
    jobRuntime: jobRuntime as never,
  }, {
    apiKeys: {
      "owner-a-key": ["agent:run", "agent:read"],
      "owner-b-key": ["agent:run", "agent:read"],
    },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const request = (key: string, url: string, method = "GET", body?: unknown) =>
    fetch(base + url, {
      method,
      headers: { authorization: "Bearer " + key, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  try {
    const created = await request("owner-a-key", "/v1/jobs", "POST", { task: "private owner A task" });
    assert.equal(created.status, 202);
    const job = await created.json() as { id: string };

    assert.equal((await request("owner-b-key", "/v1/jobs/" + job.id)).status, 404);
    assert.equal((await request("owner-b-key", "/v1/jobs/" + job.id + "/cancel", "POST")).status, 404);
    assert.equal((await request("owner-b-key", "/v1/jobs/" + job.id + "/resume", "POST")).status, 404);
    const ownerBList = await request("owner-b-key", "/v1/jobs");
    assert.deepEqual((await ownerBList.json() as { jobs: unknown[] }).jobs, []);

    assert.equal((await request("owner-a-key", "/v1/jobs/" + job.id)).status, 200);
    assert.equal((await request("owner-a-key", "/v1/jobs/" + job.id + "/cancel", "POST")).status, 202);

    const ownerA = createHash("sha256").update("owner-a-key").digest("hex").slice(0, 32);
    const ownerB = createHash("sha256").update("owner-b-key").digest("hex").slice(0, 32);
    assert.ok(calls.some((call) => call.operation === "get" && call.owner === ownerA));
    assert.ok(calls.some((call) => call.operation === "get" && call.owner === ownerB));
    assert.ok(calls.some((call) => call.operation === "list" && call.owner === ownerB));
    assert.ok(calls.some((call) => call.operation === "cancel" && call.owner === ownerA));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
