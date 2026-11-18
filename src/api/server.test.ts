import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSofiaApi } from "./server.js";
import { MemorySessionStore } from "../session/store.js";
import { ApprovalBroker, InMemoryApprovalDecisionStore } from "../agent/approval-broker.js";
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
  const pending = broker.handle({
    runId: "api-approval-run",
    principalId: ownerId,
    toolName: "workspace.write_file",
    input: { path: "safe.txt", content: "approved" },
    actionHash: "a".repeat(64),
    risk: "high",
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
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

