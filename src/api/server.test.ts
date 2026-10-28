import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSofiaApi } from "./server.js";
import { MemorySessionStore } from "../session/store.js";
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


test("model preferences are persisted per API key and validated at the API boundary", async () => {
  const preferences = new Map<string, "auto" | "fast" | "coding" | "reasoning" | "vision">();
  const modelPreferenceStore = {
    get: (ownerKeyId: string) => preferences.get(ownerKeyId),
    set: (ownerKeyId: string, selection: "auto" | "fast" | "coding" | "reasoning" | "vision") => { preferences.set(ownerKeyId, selection); },
  };
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "Task completed." }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
  }, {
    apiKeys: {
      "model-key-one": ["agent:run", "agent:read"],
      "model-key-two": ["agent:run", "agent:read"],
      "read-only-key": ["agent:read"],
    },
    modelPreferenceStore,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = (key: string, method = "GET", body?: unknown) => fetch(`${baseUrl}/v1/settings/model`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  try {
    const initial = await request("model-key-one");
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), { modelSelection: "auto", source: "default" });

    const saved = await request("model-key-one", "PUT", { modelSelection: "coding" });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { modelSelection: "coding", source: "saved" });

    const own = await request("model-key-one");
    assert.deepEqual(await own.json(), { modelSelection: "coding", source: "saved" });
    const other = await request("model-key-two");
    assert.deepEqual(await other.json(), { modelSelection: "auto", source: "default" });

    assert.equal((await request("model-key-one", "PUT", { modelSelection: "arbitrary-model" })).status, 400);
    assert.equal((await request("read-only-key", "PUT", { modelSelection: "fast" })).status, 403);
    const reset = await request("model-key-one", "DELETE");
    assert.deepEqual(await reset.json(), { modelSelection: "auto", source: "saved" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("web chat keeps API keys server-side and scopes cookie sessions to same-origin requests", async () => {
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "Task completed." }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
  }, {
    apiKeys: {
      "web-key-one": ["agent:run", "agent:read"],
      "read-only-key": ["agent:read"],
    },
    modelPreferenceStore: {
      get: () => undefined,
      set: () => undefined,
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const origin = baseUrl;

  try {
    const page = await fetch(`${baseUrl}/web-chat`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.match(await page.text(), /no \/run command needed/);

    const login = await fetch(`${baseUrl}/web-chat/session`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "web-key-one" }),
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Secure/);
    const cookie = setCookie.split(";", 1)[0];
    assert.ok(cookie);
    assert.ok(cookie.includes("="));

    const preference = await fetch(`${baseUrl}/v1/settings/model`, {
      headers: { cookie, origin, "sec-fetch-site": "same-origin" },
    });
    assert.equal(preference.status, 200);
    assert.deepEqual(await preference.json(), { modelSelection: "auto", source: "default" });

    const crossOrigin = await fetch(`${baseUrl}/v1/settings/model`, {
      method: "PUT",
      headers: { cookie, origin: "https://attacker.invalid", "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ modelSelection: "coding" }),
    });
    assert.equal(crossOrigin.status, 403);

    const invalidLogin = await fetch(`${baseUrl}/web-chat/session`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "unknown-key" }),
    });
    assert.equal(invalidLogin.status, 401);

    const logout = await fetch(`${baseUrl}/web-chat/session`, {
      method: "DELETE",
      headers: { origin, cookie, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(logout.status, 200);
    const afterLogout = await fetch(`${baseUrl}/v1/settings/model`, {
      headers: { cookie, origin, "sec-fetch-site": "same-origin" },
    });
    assert.equal(afterLogout.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
