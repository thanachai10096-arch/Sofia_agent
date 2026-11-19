import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { FileRunRecordStore } from "./run-record-store.js";
import { createSofiaApi } from "./server.js";
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

test("API usage quotas and usage reports are isolated by authenticated API key", async () => {
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "ok" }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "verified" }) },
  }, {
    apiKeys: {
      "quota-owner-one": ["agent:run", "agent:read"],
      "quota-owner-two": ["agent:run", "agent:read"],
    },
    maxRunsPerKeyPerDay: 1,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const run = (key: string) => fetch(baseUrl + "/v1/agent/runs", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ task: "quota isolation check" }),
  });
  const usage = async (key: string) => (await fetch(baseUrl + "/v1/usage", {
    headers: { authorization: `Bearer ${key}` },
  })).json() as Promise<{ keyId: string; runs: number }>;

  try {
    assert.equal((await run("quota-owner-one")).status, 200);
    assert.equal((await run("quota-owner-one")).status, 429);
    assert.equal((await run("quota-owner-two")).status, 200);

    const first = await usage("quota-owner-one");
    const second = await usage("quota-owner-two");
    const idFor = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);
    assert.equal(first.keyId, idFor("quota-owner-one"));
    assert.equal(first.runs, 1);
    assert.equal(second.keyId, idFor("quota-owner-two"));
    assert.equal(second.runs, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("API cron schedules persist in separate owner files and remain invisible across API keys", async () => {
  const cronStoreRoot = await mkdtemp(path.join(tmpdir(), "sofia-api-cron-tenant-test-"));
  const runtime = {
    async submit() { throw new Error("future schedules must not dispatch in this test"); },
    async getForOwner() { return undefined; },
    async cancelForOwner() { return true; },
  };
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
    jobRuntime: runtime as never,
  }, {
    apiKeys: {
      "cron-owner-one": ["cron:read", "cron:manage"],
      "cron-owner-two": ["cron:read", "cron:manage"],
    },
    cronStoreRoot,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = "http://127.0.0.1:" + address.port;
  const headers = (key: string) => ({ authorization: "Bearer " + key, "content-type": "application/json" });
  try {
    const created = await fetch(baseUrl + "/v1/cron/schedules", {
      method: "POST",
      headers: headers("cron-owner-one"),
      body: JSON.stringify({
        name: "owner one", task: "safe future task",
        runAt: "2099-01-01T00:00:00.000Z", timeZone: "UTC",
      }),
    });
    assert.equal(created.status, 201);
    const ownList = await fetch(baseUrl + "/v1/cron/schedules", {
      headers: headers("cron-owner-one"),
    });
    const otherList = await fetch(baseUrl + "/v1/cron/schedules", {
      headers: headers("cron-owner-two"),
    });
    assert.equal((await ownList.json() as { schedules: unknown[] }).schedules.length, 1);
    assert.equal((await otherList.json() as { schedules: unknown[] }).schedules.length, 0);

    const ownerOneId = createHash("sha256").update("cron-owner-one").digest("hex").slice(0, 32);
    const ownerTwoId = createHash("sha256").update("cron-owner-two").digest("hex").slice(0, 32);
    const files = await readdir(cronStoreRoot);
    assert.ok(files.includes(createHash("sha256").update(ownerOneId).digest("hex") + ".json"));
    assert.ok(files.includes(createHash("sha256").update(ownerTwoId).digest("hex") + ".json"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(cronStoreRoot, { recursive: true, force: true });
  }
});


test("API run records are physically partitioned by authenticated API key", async () => {
  const runStoreRoot = await mkdtemp(path.join(tmpdir(), "sofia-api-run-tenant-test-"));
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
  }, {
    apiKeys: {
      "run-owner-one": ["agent:run", "agent:read"],
      "run-owner-two": ["agent:run", "agent:read"],
    },
    runStoreRoot,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = "http://127.0.0.1:" + address.port;
  const start = async (key: string) => {
    const response = await fetch(baseUrl + "/v1/agent/runs", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({ task: "tenant run record isolation", async: true }),
    });
    assert.equal(response.status, 202);
    return (await response.json() as { id: string }).id;
  };
  try {
    const [firstRunId, secondRunId] = await Promise.all([
      start("run-owner-one"),
      start("run-owner-two"),
    ]);
    const ownerOneId = createHash("sha256").update("run-owner-one").digest("hex").slice(0, 32);
    const ownerTwoId = createHash("sha256").update("run-owner-two").digest("hex").slice(0, 32);
    const directoryOne = createHash("sha256").update("sofia-run-store:v1:").update(ownerOneId).digest("hex");
    const directoryTwo = createHash("sha256").update("sofia-run-store:v1:").update(ownerTwoId).digest("hex");
    assert.notEqual(directoryOne, directoryTwo);
    assert.deepEqual(await readdir(path.join(runStoreRoot, directoryOne)), [firstRunId + ".json"]);
    assert.deepEqual(await readdir(path.join(runStoreRoot, directoryTwo)), [secondRunId + ".json"]);

    const foreignRead = await fetch(baseUrl + "/v1/agent/runs/" + firstRunId, {
      headers: { authorization: "Bearer run-owner-two" },
    });
    assert.equal(foreignRead.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(runStoreRoot, { recursive: true, force: true });
  }
});


test("API refuses a shared persistent run store when multiple API keys are configured", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sofia-api-shared-run-store-"));
  try {
    assert.throws(() => createSofiaApi({
      provider: { generate: async () => ({ text: "unused" }) },
      router: { select: () => route, markUnhealthy: () => undefined },
      reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
    }, {
      apiKeys: {
        "shared-store-owner-one": ["agent:run"],
        "shared-store-owner-two": ["agent:run"],
      },
      runStore: new FileRunRecordStore(directory),
    }), /runStoreRoot is required/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("API runs use a distinct dependency bundle for each authenticated owner", async () => {
  const createdOwners: string[] = [];
  const closedOwners: string[] = [];
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "shared fallback must not run" }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
  }, {
    apiKeys: {
      "tenant-run-owner-one": ["agent:run", "agent:read"],
      "tenant-run-owner-two": ["agent:run", "agent:read"],
    },
    dependenciesForOwner: async ownerKeyId => {
      createdOwners.push(ownerKeyId);
      return {
        provider: { generate: async () => { generatedOwners.push(ownerKeyId); return { text: "tenant scoped result" }; } },
        router: { select: () => route, markUnhealthy: () => undefined },
        reviewer: { review: async () => ({ approved: true, reason: "tenant scoped" }) },
        close: async () => { closedOwners.push(ownerKeyId); },
      };
    },
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = "http://127.0.0.1:" + address.port;
  const run = async (key: string) => {
    const response = await fetch(baseUrl + "/v1/agent/runs", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({ task: "owner scoped task" }),
    });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ result?: { summary?: string } }>;
  };
  const ownerOneId = createHash("sha256").update("tenant-run-owner-one").digest("hex").slice(0, 32);
  const ownerTwoId = createHash("sha256").update("tenant-run-owner-two").digest("hex").slice(0, 32);
  try {
    const first = await run("tenant-run-owner-one");
    const second = await run("tenant-run-owner-two");
    assert.ok(first.result);
    assert.ok(second.result);
    assert.deepEqual(generatedOwners.sort(), [ownerOneId, ownerTwoId].sort());
    assert.deepEqual(createdOwners.sort(), [ownerOneId, ownerTwoId].sort());
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(closedOwners.sort(), [ownerOneId, ownerTwoId].sort());
});

