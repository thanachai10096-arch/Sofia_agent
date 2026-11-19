import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSofiaApi } from "./server.js";
import { MemorySessionStore } from "../session/store.js";
import { ApprovalBroker, InMemoryApprovalDecisionStore } from "../agent/approval-broker.js";
import { ModelRouter } from "../models/router.js";
import type { ModelRoute } from "../models/types.js";
import { RegistryToolGateway } from "../brain/registry-tool-gateway.js";
import { MapToolRegistry } from "../tools/types.js";
import { defaultPolicy } from "../security/policy.js";
import type { WorkspaceRuntime } from "../platform/runtime.js";
import type { BrainRunSnapshot } from "../brain/run-state.js";
import type { SofiaBrain } from "../brain/executor.js";

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



test("API resolves each project workspace inside the authenticated principal boundary", async () => {
  const ownerKey = "workspace-owner-key";
  const otherKey = "workspace-other-key";
  const resolved: string[] = [];
  const baseDependencies = {
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
  };
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "shared fallback must not run" }) },
    ...baseDependencies,
  }, {
    apiKeys: {
      [ownerKey]: ["agent:run"],
      [otherKey]: ["agent:run"],
    },
    resolveWorkspaceDependencies: async (principalId, workspaceId) => {
      resolved.push(principalId + ":" + workspaceId);
      return {
        ...baseDependencies,
        provider: { generate: async () => ({ text: principalId + ":" + workspaceId }) },
      };
    },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = "http://127.0.0.1:" + address.port;
  try {
    const run = async (key: string) => {
      const response = await fetch(baseUrl + "/v1/agent/runs", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ task: "inspect this project", workspace: "same-project" }),
      });
      assert.equal(response.status, 200);
      return (await response.json() as { result: { output: string } }).result.output;
    };
    const ownerId = createHash("sha256").update(ownerKey).digest("hex").slice(0, 32);
    const otherId = createHash("sha256").update(otherKey).digest("hex").slice(0, 32);
    assert.equal(await run(ownerKey), ownerId + ":same-project");
    assert.equal(await run(otherKey), otherId + ":same-project");
    assert.deepEqual(resolved, [ownerId + ":same-project", otherId + ":same-project"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("multi-project hosts reject shared durable job and cron routes", async () => {
  let workspaceResolverCalls = 0;
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
  }, {
    apiKeys: { "workspace-key": ["agent:run", "agent:read", "cron:read", "cron:manage"] },
    resolveWorkspaceDependencies: async () => {
      workspaceResolverCalls += 1;
      return {
        provider: { generate: async () => ({ text: "unused" }) },
        router: { select: () => route, markUnhealthy: () => undefined },
        reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
      };
    },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = "http://127.0.0.1:" + address.port;
  const auth = { authorization: "Bearer workspace-key" };
  try {
    const jobsResponse = await fetch(baseUrl + "/v1/jobs", { headers: auth });
    assert.equal(jobsResponse.status, 400);
    assert.deepEqual(await jobsResponse.json(), { error: "workspace_required" });

    // A workspace selector must not accidentally opt into the host-global cron store.
    const cronWithoutWorkspace = await fetch(baseUrl + "/v1/cron/schedules", { headers: auth });
    assert.equal(cronWithoutWorkspace.status, 503);
    assert.deepEqual(await cronWithoutWorkspace.json(), { error: "project_scoped_cron_unavailable" });

    const cronWithWorkspace = await fetch(baseUrl + "/v1/cron/schedules?workspace=project-a", { headers: auth });
    assert.equal(cronWithWorkspace.status, 503);
    assert.deepEqual(await cronWithWorkspace.json(), { error: "project_scoped_cron_unavailable" });

    const createCronWithWorkspace = await fetch(baseUrl + "/v1/cron/schedules?workspace=project-a", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "unsafe", task: "must not dispatch", cron: "* * * * *", timeZone: "Asia/Bangkok" }),
    });
    assert.equal(createCronWithWorkspace.status, 503);
    assert.deepEqual(await createCronWithWorkspace.json(), { error: "project_scoped_cron_unavailable" });
    assert.equal(workspaceResolverCalls, 0, "cron requests must fail closed before resolving or creating any project runtime");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("durable jobs are routed to the authenticated owner's selected project runtime", async () => {
  const keys = ["job-owner-one", "job-owner-two"];
  const calls: string[] = [];
  const records = new Map<string, Map<string, { id: string; status: "queued"; createdAt: string; updatedAt: string; task: string; ownerKeyId: string }>>();
  const makeRuntime = (principalId: string, workspaceId: string) => {
    const scope = principalId + ":" + workspaceId;
    calls.push(scope);
    let store = records.get(scope);
    if (!store) { store = new Map(); records.set(scope, store); }
    return {
      submit: async (input: { task: string; ownerKeyId?: string }) => {
        const record = { id: "job-" + principalId.slice(0, 6) + "-" + workspaceId, status: "queued" as const,
          createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), task: input.task,
          ownerKeyId: input.ownerKeyId ?? principalId };
        store!.set(record.id, record);
        return record;
      },
      get: async (id: string) => store!.get(id),
      list: async () => [...store!.values()],
      resume: async (id: string) => store!.get(id)!,
      cancel: async (id: string) => store!.has(id),
    };
  };
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
  }, {
    apiKeys: { ...Object.fromEntries(keys.map((key) => [key, ["agent:run", "agent:read"]])), "read-only-job-key": ["agent:read"] },
    resolveWorkspaceDependencies: async (principalId, workspaceId) => ({
      provider: { generate: async () => ({ text: "unused" }) },
      router: { select: () => route, markUnhealthy: () => undefined },
      reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
      jobRuntime: makeRuntime(principalId, workspaceId),
    }),
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = "http://127.0.0.1:" + address.port;
  const ownerId = createHash("sha256").update(keys[0]!).digest("hex").slice(0, 32);
  const otherId = createHash("sha256").update(keys[1]!).digest("hex").slice(0, 32);
  try {
    const forbiddenSubmit = await fetch(baseUrl + "/v1/jobs?workspace=project-a", {
      method: "POST",
      headers: { authorization: "Bearer read-only-job-key", "content-type": "application/json" },
      body: JSON.stringify({ task: "must not be accepted", workspace: "project-a" }),
    });
    assert.equal(forbiddenSubmit.status, 403);

    const conflictingWorkspace = await fetch(baseUrl + "/v1/jobs?workspace=project-b", {
      method: "POST",
      headers: { authorization: "Bearer " + keys[0], "content-type": "application/json" },
      body: JSON.stringify({ task: "must not select an ambiguous project", workspace: "project-a" }),
    });
    assert.equal(conflictingWorkspace.status, 400);
    assert.deepEqual(await conflictingWorkspace.json(), { error: "workspace_selector_mismatch" });

    const submit = async (key: string) => fetch(baseUrl + "/v1/jobs", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({ task: "build project", workspace: "project-a" }),
    });
    const first = await submit(keys[0]!);
    const second = await submit(keys[1]!);
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    const firstJob = await first.json() as { id: string };
    const secondJob = await second.json() as { id: string };
    assert.notEqual(firstJob.id, secondJob.id);

    const read = async (key: string, id: string, workspace: string) => fetch(
      baseUrl + "/v1/jobs/" + id + "?workspace=" + workspace,
      { headers: { authorization: "Bearer " + key } },
    );
    assert.equal((await read(keys[0]!, firstJob.id, "project-a")).status, 200);
    assert.equal((await read(keys[1]!, firstJob.id, "project-a")).status, 404);
    assert.equal((await read(keys[1]!, secondJob.id, "project-a")).status, 200);
    const list = await fetch(baseUrl + "/v1/jobs?workspace=project-a", {
      headers: { authorization: "Bearer " + keys[0] },
    });
    assert.equal(list.status, 200);
    assert.equal((await list.json() as { jobs: unknown[] }).jobs.length, 1);
    assert.deepEqual(calls, [ownerId + ":project-a", otherId + ":project-a", ownerId + ":project-a",
      otherId + ":project-a", otherId + ":project-a", ownerId + ":project-a"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("API rejects filesystem paths masquerading as project workspace IDs", async () => {
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "must not run" }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
  }, { apiKeys: { "workspace-key": ["agent:run"] } });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch("http://127.0.0.1:" + address.port + "/v1/agent/runs", {
      method: "POST",
      headers: { authorization: "Bearer workspace-key", "content-type": "application/json" },
      body: JSON.stringify({ task: "read files", workspace: "../../another-user" }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_workspace_id" });
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


test("API ignores client-supplied principalId and derives identity only from bearer authentication", async () => {
  const observedPrincipals: string[] = [];
  const apiKey = "trusted-api-key";
  const expectedPrincipal = createHash("sha256").update(apiKey).digest("hex").slice(0, 32);
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "Task completed." }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
    userMemoryStore: {
      async save() {},
      async list() { return []; },
      async find(userId: string) { observedPrincipals.push(userId); return []; },
      async delete() { return false; },
      async clear() {},
    },
  }, { apiKeys: { [apiKey]: ["agent:run"] } });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch("http://127.0.0.1:" + address.port + "/v1/agent/runs", {
      method: "POST",
      headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        task: "read my preferences",
        principalId: "attacker-selected-victim",
        ownerKeyId: "another-user",
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(observedPrincipals, [expectedPrincipal]);
    assert.notEqual(observedPrincipals[0], "attacker-selected-victim");
    assert.notEqual(observedPrincipals[0], "another-user");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("approval API lists and resolves only requests owned by the authenticated principal", async () => {
  const ownerKey = "approval-owner-key";
  const outsiderKey = "approval-outsider-key";
  const ownerId = createHash("sha256").update(ownerKey).digest("hex").slice(0, 32);
  const broker = new ApprovalBroker({ store: new InMemoryApprovalDecisionStore(), pollIntervalMs: 25 });
  const controller = new AbortController();
  const pending = broker.handle({
    runId: "api-approval-run",
    principalId: ownerId,
    toolName: "workspace.write_file",
    input: { path: "safe.txt", content: "approved" },
    actionHash: "a".repeat(64),
    risk: "high",
    signal: controller.signal,
  });
  const [record] = await broker.listPending(ownerId);
  assert.ok(record);
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "Task completed." }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
    approvalBroker: broker,
  }, {
    apiKeys: {
      [ownerKey]: ["agent:run", "approval:manage"],
      [outsiderKey]: ["approval:manage"],
      "approval-viewer-key": ["agent:read"],
    },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const auth = (key: string) => ({ authorization: "Bearer " + key });
  try {
    const ownerList = await fetch(base + "/v1/approvals", { headers: auth(ownerKey) });
    assert.equal(ownerList.status, 200);
    assert.equal((await ownerList.json() as { approvals: unknown[] }).approvals.length, 1);

    const outsiderList = await fetch(base + "/v1/approvals", { headers: auth(outsiderKey) });
    assert.equal(outsiderList.status, 200);
    assert.deepEqual((await outsiderList.json() as { approvals: unknown[] }).approvals, []);

    const hidden = await fetch(base + "/v1/approvals/" + record.id + "/approve", {
      method: "POST",
      headers: { ...auth(outsiderKey), "content-type": "application/json" },
      body: JSON.stringify({ actionHash: "a".repeat(64) }),
    });
    assert.equal(hidden.status, 404);

    const forbidden = await fetch(base + "/v1/approvals", { headers: auth("approval-viewer-key") });
    assert.equal(forbidden.status, 403);

    const wrongHash = await fetch(base + "/v1/approvals/" + record.id + "/approve", {
      method: "POST",
      headers: { ...auth(ownerKey), "content-type": "application/json" },
      body: JSON.stringify({ actionHash: "b".repeat(64) }),
    });
    assert.equal(wrongHash.status, 409);

    const approved = await fetch(base + "/v1/approvals/" + record.id + "/approve", {
      method: "POST",
      headers: { ...auth(ownerKey), "content-type": "application/json" },
      body: JSON.stringify({ actionHash: "a".repeat(64) }),
    });
    assert.equal(approved.status, 200);
    assert.deepEqual(await approved.json(), { id: record.id, status: "approved" });
    assert.equal(await pending, true);

    const replay = await fetch(base + "/v1/approvals/" + record.id + "/deny", {
      method: "POST",
      headers: { ...auth(ownerKey), "content-type": "application/json" },
      body: JSON.stringify({ actionHash: "a".repeat(64) }),
    });
    assert.equal(replay.status, 409);

    const denialPending = broker.handle({
      runId: "api-approval-denial-run",
      principalId: ownerId,
      toolName: "workspace.write_file",
      input: { path: "blocked.txt", content: "must not execute" },
      actionHash: "c".repeat(64),
      risk: "high",
      signal: controller.signal,
    });
    const [denialRecord] = await broker.listPending(ownerId);
    assert.ok(denialRecord);
    const denied = await fetch(base + "/v1/approvals/" + denialRecord.id + "/deny", {
      method: "POST",
      headers: { ...auth(ownerKey), "content-type": "application/json" },
      body: JSON.stringify({ actionHash: "c".repeat(64) }),
    });
    assert.equal(denied.status, 200);
    assert.deepEqual(await denied.json(), { id: denialRecord.id, status: "denied" });
    assert.equal(await denialPending, false);
  } finally {
    controller.abort(new Error("test cleanup"));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});



test("async API runs durably persist redacted Brain checkpoints", async () => {
  const apiKey = "checkpoint-owner-key";
  const saved: Array<{ id: string; snapshot?: BrainRunSnapshot }> = [];
  const snapshot: BrainRunSnapshot = {
    version: 1,
    runId: "brain-run-checkpoint-01",
    task: "inspect workspace",
    understanding: {
      objective: "inspect workspace", constraints: [], assumptions: [], requiredCapabilities: [],
      requiredTools: [], risk: "low", successCriteria: [], ambiguities: [],
    },
    plan: { strategy: "initial", reason: "test", steps: [] },
    acceptanceCriteria: [],
    completedStepIds: [],
    checkpointId: "workspace-checkpoint-01",
    usage: { steps: 0, toolCalls: 0, modelCalls: 0, reservedOrUsedTokens: 0, replans: 0 },
    observations: [], diagnoses: [], decisions: [], recoveryRounds: 0, trace: [],
  };
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
    brainFactory: (options) => ({
      runId: "brain-run-checkpoint-01",
      run: async () => {
        await options.onRunSnapshot?.(snapshot);
        return {
          completed: true, state: "completed", summary: "Checkpoint persisted.",
          changedFiles: [], changedFilesKnown: true, verification: [], remainingRisks: [],
          usage: snapshot.usage,
        };
      },
    } as unknown as SofiaBrain),
  }, {
    apiKeys: { [apiKey]: ["agent:run", "agent:read"] },
    runStore: {
      save: async (record) => { saved.push({ id: record.id, snapshot: record.snapshot }); },
      remove: async () => {},
      loadAllSync: () => [],
    },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const started = await fetch("http://127.0.0.1:" + address.port + "/v1/agent/runs", {
      method: "POST",
      headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
      body: JSON.stringify({ task: "inspect workspace", async: true }),
    });
    assert.equal(started.status, 202);
    const body = await started.json() as { id: string };
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (saved.some((record) => record.id === body.id && record.snapshot?.checkpointId === snapshot.checkpointId)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(saved.some((record) => record.id === body.id && record.snapshot?.checkpointId === snapshot.checkpointId));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("server restart marks persisted in-flight runs interrupted instead of replaying side effects", async () => {
  const ownerKey = "restart-owner-key";
  const ownerKeyId = createHash("sha256").update(ownerKey).digest("hex").slice(0, 32);
  const persisted: Array<{ id: string; status: string; error?: string }> = [];
  const interruptedId = "12345678-1234-4234-8234-123456789abc";
  const runStore = {
    save: async (record: { id: string; status: string; error?: string }) => { persisted.push(record); },
    remove: async () => {},
    loadAllSync: () => [{
      id: interruptedId,
      status: "running" as const,
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now() - 500,
      ownerKeyId,
      desktopCapabilities: [],
    }],
    load: () => undefined,
  };
  let agentCalls = 0;
  const server = createSofiaApi({
    provider: { generate: async () => { agentCalls += 1; return { text: "must not replay" }; } },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
  }, {
    apiKeys: { [ownerKey]: ["agent:run", "agent:read"] },
    runStore,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch("http://127.0.0.1:" + address.port + "/v1/agent/runs/" + interruptedId, {
      headers: { authorization: "Bearer " + ownerKey },
    });
    assert.equal(response.status, 200);
    const recovered = await response.json() as { status: string; error?: string };
    assert.equal(recovered.status, "failed");
    assert.match(recovered.error ?? "", /interrupted by server restart/i);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(persisted.some((record) => record.id === interruptedId && record.status === "failed"));
    assert.equal(agentCalls, 0, "restart recovery must not automatically replay an interrupted agent run");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("async run cancellation is owner-scoped and reaches the active execution signal", async () => {
  const ownerKey = "run-owner-key";
  const otherKey = "run-other-key";
  let executionStarted!: () => void;
  const started = new Promise<void>((resolve) => { executionStarted = resolve; });
  const server = createSofiaApi({
    provider: {
      generate: async (_request, _route, options) => {
        executionStarted();
        return await new Promise<never>((_resolve, reject) => {
          if (options?.signal?.aborted) {
            reject(options.signal.reason ?? new Error("aborted"));
            return;
          }
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason ?? new Error("aborted")), { once: true });
        });
      },
    },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
  }, {
    apiKeys: {
      [ownerKey]: ["agent:run", "agent:read"],
      [otherKey]: ["agent:run", "agent:read"],
    },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const auth = (key: string) => ({ authorization: "Bearer " + key });
  try {
    const created = await fetch(base + "/v1/agent/runs", {
      method: "POST",
      headers: { ...auth(ownerKey), "content-type": "application/json" },
      body: JSON.stringify({ task: "perform a task", async: true }),
    });
    assert.equal(created.status, 202);
    const run = await created.json() as { id: string; status: string };
    await started;

    const hidden = await fetch(base + "/v1/agent/runs/" + run.id, {
      method: "DELETE",
      headers: auth(otherKey),
    });
    assert.equal(hidden.status, 404);

    const cancelled = await fetch(base + "/v1/agent/runs/" + run.id, {
      method: "DELETE",
      headers: auth(ownerKey),
    });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json() as { status: string }).status, "cancelled");

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await fetch(base + "/v1/agent/runs/" + run.id, { headers: auth(ownerKey) });
      assert.equal(status.status, 200);
      const current = await status.json() as { status: string };
      if (current.status === "cancelled") return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Cancelled run did not reach a terminal state");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("API approval decision gates the actual effectful tool execution", async () => {
  const ownerKey = "approval-e2e-owner-key";
  const ownerId = createHash("sha256").update(ownerKey).digest("hex").slice(0, 32);
  const broker = new ApprovalBroker({
    store: new InMemoryApprovalDecisionStore(),
    pollIntervalMs: 25,
    ttlMs: 10_000,
  });
  const files = new Map<string, string>();
  const runtime: WorkspaceRuntime = {
    platform: "linux",
    async cwd() { return "/workspace"; },
    async readFile(path) {
      const value = files.get(path);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    async writeFile(path, content) { files.set(path, content); },
    async listFiles() { return [...files.keys()]; },
    async search() { return []; },
    async run() { return { stdout: "", stderr: "", code: 0 }; },
    async git() { return { stdout: "", stderr: "", code: 0 }; },
  };
  let executions = 0;
  const registry = new MapToolRegistry([{
    name: "custom.write",
    description: "Write a file only after its exact action is approved",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    effects: ["write"] as const,
    async execute(input) {
      executions += 1;
      const value = input as { path: string; content: string };
      await runtime.writeFile(value.path, value.content);
      return { written: value.path };
    },
  }]);
  const gateway = new RegistryToolGateway(
    { runtime, tools: registry },
    { ...defaultPolicy, capabilitySecret: "api-approval-e2e-test-secret" },
    broker.handle,
  );
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
    approvalBroker: broker,
  }, {
    apiKeys: { [ownerKey]: ["agent:run", "agent:read", "approval:manage"] },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const controller = new AbortController();
  try {
    const execution = gateway.execute(
      { tool: "custom.write", input: { path: "approved.txt", content: "authorized" } },
      {
        runId: "api-gateway-approval-e2e",
        principalId: ownerId,
        signal: controller.signal,
        requireApproval: true,
        notifyApproval() {},
      },
    );

    let approvals: Array<{ id: string; actionHash: string; runId: string; toolName: string }> = [];
    for (let attempt = 0; attempt < 100 && approvals.length !== 1; attempt += 1) {
      const response = await fetch(base + "/v1/approvals", {
        headers: { authorization: "Bearer " + ownerKey },
      });
      assert.equal(response.status, 200);
      approvals = (await response.json() as { approvals: typeof approvals }).approvals;
      if (approvals.length !== 1) await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.equal(approvals.length, 1, "the API inbox must expose the gateway's pending approval");
    const pending = approvals[0]!;
    assert.equal(pending.runId, "api-gateway-approval-e2e");
    assert.equal(pending.toolName, "custom.write");
    assert.equal(executions, 0, "the side effect must not run before the HTTP approval decision");
    assert.equal(files.has("approved.txt"), false);

    const response = await fetch(base + "/v1/approvals/" + pending.id + "/approve", {
      method: "POST",
      headers: { authorization: "Bearer " + ownerKey, "content-type": "application/json" },
      body: JSON.stringify({ actionHash: pending.actionHash }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: pending.id, status: "approved" });

    const result = await execution;
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { written: "approved.txt" });
    assert.equal(executions, 1);
    assert.equal(await runtime.readFile("approved.txt"), "authorized");
  } finally {
    controller.abort(new Error("test cleanup"));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
