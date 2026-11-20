import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSofiaApi } from "./server.js";
import { MemorySessionStore } from "../session/store.js";
import { ModelRouter } from "../models/router.js";
import type { ModelRoute } from "../models/types.js";
import type { RunRecord, RunRecordStore } from "./run-record-store.js";

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


test("API job endpoints hide another principal's jobs and block cross-principal actions", async () => {
  const job = {
    id: "tenant-job-1",
    status: "failed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    task: "private job",
    ownerKeyId: createHash("sha256").update("key-one").digest("hex").slice(0, 32),
    snapshot: { checkpointId: "private-checkpoint" },
  };
  const calls = { resume: 0, cancel: 0 };
  const runtime = {
    async get(id: string) { return id === job.id ? job : undefined; },
    async list() { return [job]; },
    async resume() { calls.resume += 1; return { ...job, status: "running" }; },
    async cancel() { calls.cancel += 1; return true; },
    async submit() { throw new Error("not used"); },
  };
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
    jobRuntime: runtime as never,
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
  const request = (key: string, path: string, method = "GET") =>
    fetch(baseUrl + path, { method, headers: { authorization: `Bearer ${key}` } });

  try {
    const ownerRead = await request("key-one", `/v1/jobs/${job.id}`);
    assert.equal(ownerRead.status, 200);

    const foreignRead = await request("key-two", `/v1/jobs/${job.id}`);
    assert.equal(foreignRead.status, 404);

    const foreignResume = await request("key-two", `/v1/jobs/${job.id}/resume`, "POST");
    assert.equal(foreignResume.status, 404);

    const foreignCancel = await request("key-two", `/v1/jobs/${job.id}/cancel`, "POST");
    assert.equal(foreignCancel.status, 404);

    const foreignList = await request("key-two", "/v1/jobs");
    assert.equal(foreignList.status, 200);
    assert.deepEqual(await foreignList.json(), { jobs: [] });

    assert.deepEqual(calls, { resume: 0, cancel: 0 }, "unauthorized requests must not invoke job mutations");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("synchronous API runs use the authenticated principal dependency graph", async () => {
  const tenantRoute: ModelRoute = { ...route, id: "tenant-route" };
  const globalCalls: string[] = [];
  const tenantCalls: string[] = [];
  const baseDeps = {
    provider: { generate: async () => { globalCalls.push("global"); return { text: "global result" }; } },
    router: new ModelRouter([route]),
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
  };
  const tenantDeps = {
    provider: { generate: async () => { tenantCalls.push("tenant"); return { text: "tenant result" }; } },
    router: new ModelRouter([tenantRoute]),
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
  };
  const server = createSofiaApi(baseDeps, {
    apiKeys: { "tenant-key": ["agent:run"] },
    resolvePrincipalDependencies: async () => tenantDeps,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch("http://127.0.0.1:" + address.port + "/v1/agent/runs", {
      method: "POST",
      headers: { authorization: "Bearer tenant-key", "content-type": "application/json" },
      body: JSON.stringify({ task: "run in my tenant workspace" }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { result?: { summary?: string } };
    assert.equal(payload.result?.summary, "tenant result");
    assert.deepEqual(tenantCalls, ["tenant"]);
    assert.deepEqual(globalCalls, []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("principal run stores isolate history and restore idempotency after API restart", async () => {
  class MemoryRunRecordStore implements RunRecordStore {
    private records = new Map<string, RunRecord>();
    async save(record: RunRecord) { this.records.set(record.id, structuredClone(record)); }
    async remove(id: string) { this.records.delete(id); }
    loadAllSync() { return [...this.records.values()].map((record) => structuredClone(record)); }
    load(id: string) { const record = this.records.get(id); return record ? structuredClone(record) : undefined; }
  }

  const stores = new Map<string, MemoryRunRecordStore>();
  const resolvePrincipalRunStore = async (principalId: string) => {
    let store = stores.get(principalId);
    if (!store) { store = new MemoryRunRecordStore(); stores.set(principalId, store); }
    return store;
  };
  const makeServer = () => createSofiaApi({
    provider: { generate: async () => ({ text: "Tenant run completed." }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
  }, {
    apiKeys: {
      "tenant-one-key": ["agent:run", "agent:read"],
      "tenant-two-key": ["agent:run", "agent:read"],
    },
    resolvePrincipalRunStore,
  });

  const listen = async (server: ReturnType<typeof createSofiaApi>) => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
  };
  const close = (server: ReturnType<typeof createSofiaApi>) =>
    new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

  const firstServer = makeServer();
  const firstUrl = await listen(firstServer);
  let runId = "";
  try {
    const accepted = await fetch(firstUrl + "/v1/agent/runs", {
      method: "POST",
      headers: {
        authorization: "Bearer tenant-one-key",
        "content-type": "application/json",
        "idempotency-key": "stable-task-1",
      },
      body: JSON.stringify({ task: "tenant one's private task", async: true }),
    });
    assert.equal(accepted.status, 202);
    runId = (await accepted.json() as { id: string }).id;
    let completed = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await fetch(firstUrl + "/v1/agent/runs/" + runId, {
        headers: { authorization: "Bearer tenant-one-key" },
      });
      assert.equal(status.status, 200);
      const run = await status.json() as { status: string };
      if (run.status === "completed") { completed = true; break; }
      if (run.status === "failed" || run.status === "cancelled") {
        throw new Error(`Tenant run ended with status ${run.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(completed, true, "tenant run should complete before server restart");
    assert.equal(stores.size, 1);
  } finally {
    await close(firstServer);
  }

  const secondServer = makeServer();
  const secondUrl = await listen(secondServer);
  try {
    const ownerRead = await fetch(secondUrl + "/v1/agent/runs/" + runId, {
      headers: { authorization: "Bearer tenant-one-key" },
    });
    assert.equal(ownerRead.status, 200);
    assert.equal((await ownerRead.json() as { status: string }).status, "completed");

    const otherRead = await fetch(secondUrl + "/v1/agent/runs/" + runId, {
      headers: { authorization: "Bearer tenant-two-key" },
    });
    assert.equal(otherRead.status, 404);

    const replay = await fetch(secondUrl + "/v1/agent/runs", {
      method: "POST",
      headers: {
        authorization: "Bearer tenant-one-key",
        "content-type": "application/json",
        "idempotency-key": "stable-task-1",
      },
      body: JSON.stringify({ task: "tenant one's private task", async: true }),
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { id: string }).id, runId);

    const otherTenantStart = await fetch(secondUrl + "/v1/agent/runs", {
      method: "POST",
      headers: {
        authorization: "Bearer tenant-two-key",
        "content-type": "application/json",
        "idempotency-key": "stable-task-1",
      },
      body: JSON.stringify({ task: "tenant two's separate task", async: true }),
    });
    assert.equal(otherTenantStart.status, 202);
    assert.notEqual((await otherTenantStart.json() as { id: string }).id, runId);
  } finally {
    await close(secondServer);
  }
});


test("tenant mode disables the process-wide cron scheduler and fails cron routes closed", async () => {
  const calls = { list: 0, submit: 0 };
  const sharedRuntime = {
    async list() { calls.list += 1; return []; },
    async submit() { calls.submit += 1; throw new Error("must not submit"); },
    async get() { return undefined; },
    async resume() { throw new Error("must not resume"); },
    async cancel() { return false; },
  };
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: new ModelRouter([route]),
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
    jobRuntime: sharedRuntime as never,
  }, {
    apiKeys: { "cron-tenant-key": ["agent:run", "cron:read", "cron:manage"] },
    resolvePrincipalDependencies: async () => ({
      provider: { generate: async () => ({ text: "tenant" }) },
      router: new ModelRouter([route]),
      reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
    }),
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = "http://127.0.0.1:" + address.port;
  try {
    const list = await fetch(baseUrl + "/v1/cron/schedules", {
      headers: { authorization: "Bearer cron-tenant-key" },
    });
    assert.equal(list.status, 503);
    assert.deepEqual(await list.json(), { error: "principal_cron_runtime_unavailable" });

    const create = await fetch(baseUrl + "/v1/cron/schedules", {
      method: "POST",
      headers: { authorization: "Bearer cron-tenant-key", "content-type": "application/json" },
      body: JSON.stringify({ name: "tenant task", task: "run", timeZone: "UTC", runAt: "2030-01-01T00:00:00.000Z" }),
    });
    assert.equal(create.status, 503);
    assert.deepEqual(await create.json(), { error: "principal_cron_runtime_unavailable" });
    assert.deepEqual(calls, { list: 0, submit: 0 });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("tenant cron schedulers are isolated and recovered before their first tick", async () => {
  const events: string[] = [];
  const principalId = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);
  const schedulerFor = (id: string) => ({
    async recover() { events.push("recover:" + id); return { reconciled: 0, monitoring: 0, indeterminate: 0 }; },
    async tick() { events.push("tick:" + id); },
    async list(actor: string) { events.push("list:" + id + ":" + actor); return []; },
    async create() { throw new Error("not used"); },
    async history() { return []; },
    async setEnabled() { throw new Error("not used"); },
    async cancel() { return false; },
  });
  const resolved: string[] = [];
  const tenantRuntime = {
    async list() { return []; },
    async submit() { throw new Error("not used"); },
    async get() { return undefined; },
    async resume() { throw new Error("not used"); },
    async cancel() { return false; },
  };
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: new ModelRouter([route]),
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
  }, {
    apiKeys: { "cron-user-one": ["cron:read"], "cron-user-two": ["cron:read"] },
    resolvePrincipalDependencies: async () => ({
      provider: { generate: async () => ({ text: "tenant" }) },
      router: new ModelRouter([route]),
      reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
      jobRuntime: tenantRuntime as never,
    }),
    resolvePrincipalCronScheduler: async (id) => {
      resolved.push(id);
      return schedulerFor(id) as never;
    },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = "http://127.0.0.1:" + address.port;
  try {
    for (const key of ["cron-user-one", "cron-user-two"]) {
      const response = await fetch(baseUrl + "/v1/cron/schedules", {
        headers: { authorization: "Bearer " + key },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { schedules: [] });
    }
    const one = principalId("cron-user-one");
    const two = principalId("cron-user-two");
    assert.deepEqual(resolved, [one, two]);
    assert.deepEqual(events, [
      "recover:" + one, "tick:" + one, "list:" + one + ":" + one,
      "recover:" + two, "tick:" + two, "list:" + two + ":" + two,
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("principal usage quota files enforce limits independently per authenticated user", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sofia-principal-usage-"));
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "Quota test completed." }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
  }, {
    apiKeys: {
      "quota-user-one": ["agent:run"],
      "quota-user-two": ["agent:run"],
    },
    maxRunsPerKeyPerDay: 1,
    resolvePrincipalUsageStorePath: async (principalId) => path.join(root, principalId, "usage.json"),
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const run = (key: string) => fetch(baseUrl + "/v1/agent/runs", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ task: "complete a quota test task" }),
  });

  try {
    assert.equal((await run("quota-user-one")).status, 200);
    assert.equal((await run("quota-user-two")).status, 200);
    const exceeded = await run("quota-user-one");
    assert.equal(exceeded.status, 429);
    assert.equal((await exceeded.json() as { error: string }).error, "quota_exceeded");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
