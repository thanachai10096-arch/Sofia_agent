import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSofiaApi } from "./server.js";
import { DesktopCommandBroker } from "../desktop/remote-command-broker.js";
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



test("API derives remote desktop capabilities from authenticated scopes and passes them into Brain", async () => {
  let received: { principalId?: string; desktopCapabilities?: string[] } | undefined;
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
    brainFactory: (options) => {
      received = options;
      return {
        run: async () => ({
          completed: true,
          state: "completed",
          summary: "Brain test completed.",
          changedFiles: [],
          changedFilesKnown: true,
          verification: [],
          remainingRisks: [],
          usage: { steps: 1, toolCalls: 0, modelCalls: 1, reservedOrUsedTokens: 10, replans: 0 },
        }),
      } as never;
    },
  }, {
    apiKeys: {
      "desktop-capable": ["agent:run", "desktop:connect", "desktop:remote:input:control"],
      "desktop-connect-only": ["agent:run", "desktop:connect"],
    },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = "http://127.0.0.1:" + address.port;
  const startAndWait = async (key: string) => {
    const started = await fetch(baseUrl + "/v1/agent/runs", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({ task: "verify remote desktop scope propagation", async: true }),
    });
    assert.equal(started.status, 202);
    const run = await started.json() as { id: string };
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(baseUrl + "/v1/agent/runs/" + run.id, {
        headers: { authorization: "Bearer " + key },
      });
      assert.equal(response.status, 200);
      const status = await response.json() as { status: string };
      if (status.status === "completed") return;
      if (status.status === "failed" || status.status === "cancelled") throw new Error("Brain test run did not complete.");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Brain test run timed out.");
  };

  try {
    await startAndWait("desktop-capable");
    assert.ok(received);
    assert.equal(received.principalId, createHash("sha256").update("desktop-capable").digest("hex").slice(0, 32));
    assert.deepEqual(received.desktopCapabilities, ["input:control"]);

    received = undefined;
    await startAndWait("desktop-connect-only");
    assert.ok(received);
    assert.deepEqual(received.desktopCapabilities ?? [], []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Desktop Companion API relay enforces owner scope and completes only the paired owner's command", async () => {
  const broker = new DesktopCommandBroker();
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
  }, {
    apiKeys: {
      "desktop-owner-one": ["desktop:connect"],
      "desktop-owner-two": ["desktop:connect"],
      "no-desktop-scope": ["agent:run"],
    },
    desktopCommandBroker: broker,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = "http://127.0.0.1:" + address.port;
  const request = (path: string, token: string, init: RequestInit = {}) =>
    fetch(baseUrl + path, {
      ...init,
      headers: { authorization: "Bearer " + token, ...(init.headers as Record<string, string> | undefined) },
    });

  try {
    const denied = await request("/v1/desktop/companion/connect", "no-desktop-scope", { method: "POST" });
    assert.equal(denied.status, 403);

    const pairedOne = await request("/v1/desktop/companion/connect", "desktop-owner-one", { method: "POST" });
    assert.equal(pairedOne.status, 201);
    const tokenOne = (await pairedOne.json() as { token: string }).token;
    const pairedTwo = await request("/v1/desktop/companion/connect", "desktop-owner-two", { method: "POST" });
    assert.equal(pairedTwo.status, 201);
    const tokenTwo = (await pairedTwo.json() as { token: string }).token;

    const pending = broker.dispatch("".concat(
      createHash("sha256").update("desktop-owner-one").digest("hex").slice(0, 32),
    ), { kind: "input.click", x: 10, y: 20, button: "left" });
    const polled = await request("/v1/desktop/companion/commands", tokenOne);
    assert.equal(polled.status, 200);
    const command = (await polled.json() as { command: { id: string } }).command;
    assert.ok(command?.id);

    const crossOwner = await request(
      "/v1/desktop/companion/commands/" + command.id + "/complete",
      tokenTwo,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ result: { ok: true } }) },
    );
    assert.equal(crossOwner.status, 404);

    const completed = await request(
      "/v1/desktop/companion/commands/" + command.id + "/complete",
      tokenOne,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ result: { ok: true } }) },
    );
    assert.equal(completed.status, 200);
    assert.deepEqual(await pending, { ok: true });

    const disconnected = await request("/v1/desktop/companion/disconnect", "desktop-owner-one", { method: "POST" });
    assert.equal(disconnected.status, 200);
    const revokedPoll = await request("/v1/desktop/companion/commands", tokenOne);
    assert.equal(revokedPoll.status, 401);
  } finally {
    broker.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("Desktop Companion API awaits asynchronous broker adapters", async () => {
  const calls: string[] = [];
  const commandId = "11111111-1111-4111-8111-111111111111";
  const broker = {
    async connect(ownerKeyId: string) {
      calls.push("connect:" + ownerKeyId);
      return { token: "async-companion-token", connectedAt: 123 };
    },
    async disconnect(ownerKeyId: string) { calls.push("disconnect:" + ownerKeyId); },
    async poll(token: string) {
      calls.push("poll:" + token);
      return { id: commandId, action: { kind: "screen.capture" as const }, createdAt: 123 };
    },
    async complete(token: string, id: string, result: unknown) {
      calls.push("complete:" + token + ":" + id + ":" + JSON.stringify(result));
      return true;
    },
    async getStatus(ownerKeyId: string) {
      calls.push("status:" + ownerKeyId);
      return { connected: true, pendingCommands: 0 };
    },
    async close() {},
  };
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
  }, {
    apiKeys: { "async-desktop-owner": ["desktop:connect"] },
    desktopCommandBroker: broker,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = "http://127.0.0.1:" + address.port;
  const ownerRequest = (path: string, init: RequestInit = {}) => fetch(baseUrl + path, {
    ...init,
    headers: { authorization: "Bearer async-desktop-owner", ...(init.headers as Record<string, string> | undefined) },
  });

  try {
    const connected = await ownerRequest("/v1/desktop/companion/connect", { method: "POST" });
    assert.equal(connected.status, 201);
    assert.deepEqual(await connected.json(), { token: "async-companion-token", connectedAt: 123 });

    const status = await ownerRequest("/v1/desktop/companion/status");
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { connected: true, pendingCommands: 0 });

    const polled = await fetch(baseUrl + "/v1/desktop/companion/commands", {
      headers: { authorization: "Bearer async-companion-token" },
    });
    assert.equal(polled.status, 200);
    assert.equal(((await polled.json()) as { command: { id: string } }).command.id, commandId);

    const completed = await fetch(baseUrl + "/v1/desktop/companion/commands/" + commandId + "/complete", {
      method: "POST",
      headers: { authorization: "Bearer async-companion-token", "content-type": "application/json" },
      body: JSON.stringify({ result: { ok: true } }),
    });
    assert.equal(completed.status, 200);

    const disconnected = await ownerRequest("/v1/desktop/companion/disconnect", { method: "POST" });
    assert.equal(disconnected.status, 200);
    assert.deepEqual(calls, [
      "connect:async-desktop-owner",
      "status:async-desktop-owner",
      "poll:async-companion-token",
      "complete:async-companion-token:" + commandId + ":" + JSON.stringify({ ok: true }),
      "disconnect:async-desktop-owner",
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
