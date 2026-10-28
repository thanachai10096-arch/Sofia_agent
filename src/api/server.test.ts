import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { createSofiaApi } from "./server.js";
import { EncryptedUserModelProfileStore } from "../models/profile-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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


test("API accepts only a valid signed messaging origin and binds user principal", async () => {
  const apiKey = "chat-bridge-key";
  const secret = "server-only-test-secret-with-more-than-32-characters";
  const task = "check project status";
  const taskHash = createHash("sha256").update(task).digest("hex");
  const unsigned = {
    platform: "telegram" as const,
    userId: "user-7",
    conversationId: "chat-9",
    messageId: "message-1",
    taskHash,
  };
  const signature = createHmac("sha256", secret).update(JSON.stringify(unsigned)).digest("hex");
  const principals: string[] = [];
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "Task completed." }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
    userMemoryStore: {
      async find(userId: string) { principals.push(userId); return []; },
      async save() {}, async list() { return []; }, async delete() { return false; }, async clear() {},
    },
  }, {
    apiKeys: { [apiKey]: ["agent:run", "agent:read"] },
    messagingContextSecret: secret,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const valid = await fetch(`${baseUrl}/v1/agent/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ task, _messagingContext: { ...unsigned, signature } }),
    });
    assert.equal(valid.status, 200);
    assert.deepEqual(principals, ["telegram:user-7"]);

    const forged = await fetch(`${baseUrl}/v1/agent/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        task,
        _messagingContext: { ...unsigned, conversationId: "other-user-chat", signature },
      }),
    });
    assert.equal(forged.status, 403);
    assert.deepEqual(principals, ["telegram:user-7"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("model profile API encrypts keys, scopes access, and never returns credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sofia-model-profile-api-test-"));
  const modelProfileStore = new EncryptedUserModelProfileStore(
    path.join(directory, "profiles.json"),
    Buffer.alloc(32, 4).toString("base64"),
  );
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "Task completed." }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
    modelProfileStore,
  }, {
    apiKeys: {
      "key-profile-owner": ["agent:run", "model:profile:read", "model:profile:write"],
      "key-other-owner": ["model:profile:read", "model:profile:write"],
      "key-no-profile-scope": ["agent:run"],
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = (key: string, method: string, body?: unknown) => fetch(`${baseUrl}/v1/model-profile`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  try {
    const saved = await request("key-profile-owner", "PUT", {
      provider: "gemini", model: "gemini-2.5-flash", apiKey: "secret-provider-key-12345",
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json() as { profile: Record<string, unknown> };
    assert.equal(savedBody.profile.model, "gemini-2.5-flash");
    assert.equal("apiKey" in savedBody.profile, false);
    assert.equal(JSON.stringify(savedBody).includes("secret-provider-key-12345"), false);

    const other = await request("key-other-owner", "GET");
    assert.equal(other.status, 200);
    assert.deepEqual(await other.json(), { profile: null });

    const forbidden = await request("key-no-profile-scope", "PUT", {
      provider: "gemini", model: "gemini-2.5-flash", apiKey: "secret-provider-key-12345",
    });
    assert.equal(forbidden.status, 403);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
