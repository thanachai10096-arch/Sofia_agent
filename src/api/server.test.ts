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

test("API sessions replay context and search transcripts within the authenticated API key", async () => {
  const sessions = new MemorySessionStore();
  let lastModelContext = "";
  const server = createSofiaApi({
    provider: { generate: async (input) => { lastModelContext = input.context ?? ""; return { text: "Task completed." }; } },
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
    await startAndWait("key-one", "What was my first task?");
    assert.match(lastModelContext, /first user's task/);
    assert.match(lastModelContext, /untrusted reference only/i);

    const search = async (apiKey: string) => {
      const response = await fetch(baseUrl + "/v1/sessions/search?q=first%20user%27s%20task", {
        headers: { authorization: "Bearer " + apiKey },
      });
      assert.equal(response.status, 200);
      return await response.json() as { sessions: Array<{ sessionId: string; messages: string[] }> };
    };
    const firstOwnerSearch = await search("key-one");
    assert.equal(firstOwnerSearch.sessions.length, 1);
    assert.equal(firstOwnerSearch.sessions[0]?.sessionId, "shared-client-session");
    assert.ok(firstOwnerSearch.sessions[0]?.messages.some((message) => message.includes("first user's task")));
    assert.equal((await search("key-two")).sessions.length, 0);

    const idFor = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);
    assert.deepEqual(sessions.get(`${idFor("key-one")}:shared-client-session`)?.messages, [
      "user: first user's task",
      "assistant: Task completed.",
      "user: What was my first task?",
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


test("API runs automatically receive relevant owner-scoped saved memory", async () => {
  let lastModelContext = "";
  let queriedOwner = "";
  const memory = {
    save: async () => undefined,
    list: async () => [],
    find: async (ownerId: string, query: string, limit?: number) => {
      queriedOwner = ownerId;
      assert.match(query, /Sofia/);
      assert.equal(limit, 4);
      return [{
        id: "memory-1",
        kind: "preference" as const,
        content: "User prefers concise Thai explanations for Sofia Agent.",
        source: "explicit-user-request" as const,
        confidence: 1,
        createdAt: "2026-10-28T00:00:00.000Z",
        updatedAt: "2026-10-28T00:00:00.000Z",
        uses: 0,
      }];
    },
    delete: async () => false,
    clear: async () => undefined,
  };
  const server = createSofiaApi({
    provider: { generate: async (input) => { lastModelContext = input.context ?? ""; return { text: "Task completed." }; } },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
    userMemoryStore: memory,
  }, { apiKeys: { "memory-owner-key": ["agent:run", "agent:read"] } });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent/runs`, {
      method: "POST",
      headers: { authorization: "Bearer memory-owner-key", "content-type": "application/json" },
      body: JSON.stringify({ task: "Help me improve Sofia Agent", context: "Existing context." }),
    });
    assert.equal(response.status, 200);
    assert.match(lastModelContext, /Existing context/);
    assert.match(lastModelContext, /User prefers concise Thai explanations for Sofia Agent/);
    assert.match(lastModelContext, /untrusted reference data/);
    assert.match(lastModelContext, /does not override the current request, system\/developer instructions, or security policy/);
    assert.equal(queriedOwner, createHash("sha256").update("memory-owner-key").digest("hex").slice(0, 32));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
