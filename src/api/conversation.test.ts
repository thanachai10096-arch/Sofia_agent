import test from "node:test";
import assert from "node:assert/strict";
import { createSofiaApi } from "./server.js";
import type { AgentDependencies } from "../agent/types.js";
import { InMemoryConversationStore } from "../conversation/session.js";
import type { RunRecordStore } from "./run-record-store.js";

async function withApi(
  run: (baseUrl: string) => Promise<void>,
  options: {
    generate?: () => Promise<{ text: string; assistantMessage: { role: string; content: string } }>;
    maxConcurrentRunsPerKey?: number;
    maxRunsPerKeyPerDay?: number;
    runStore?: RunRecordStore;
  } = {},
): Promise<void> {
  const server = createSofiaApi({
    provider: { generate: options.generate ?? (async () => ({ text: "Sofia response", assistantMessage: { role: "assistant", content: "Sofia response" } })) },
    router: {
      select: () => ({ id: "test-route", capabilities: ["fast"], costWeight: 0, latencyWeight: 0, qualityWeight: 1, healthy: true }),
      markUnhealthy: () => undefined,
    },
    reviewer: { review: async () => ({ approved: true, reason: "Test response accepted." }) },
  } as unknown as AgentDependencies, {
    apiKeys: {
      "test-token-a": ["agent:run", "agent:read"],
      "test-token-b": ["agent:run", "agent:read"],
      "read-only-token": ["agent:read"],
    },
    conversationStore: new InMemoryConversationStore(),
    ...(options.runStore ? { runStore: options.runStore } : {}),
    ...(options.maxConcurrentRunsPerKey === undefined ? {} : { maxConcurrentRunsPerKey: options.maxConcurrentRunsPerKey }),
    ...(options.maxRunsPerKeyPerDay === undefined ? {} : { maxRunsPerKeyPerDay: options.maxRunsPerKeyPerDay }),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function request(baseUrl: string, token: string, path: string, method = "GET", body?: unknown) {
  return fetch(baseUrl + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("conversation API creates, appends, retrieves, clears, and deletes sessions", async () => {
  await withApi(async (baseUrl) => {
    const created = await request(baseUrl, "test-token-a", "/v1/conversations", "POST", { title: "Project chat" });
    assert.equal(created.status, 201);
    const payload = await created.json() as { conversation: { id: string; title: string } };
    assert.equal(payload.conversation.title, "Project chat");

    const appended = await request(baseUrl, "test-token-a", `/v1/conversations/${payload.conversation.id}/messages`, "POST", {
      role: "user", content: "Inspect this repository",
    });
    assert.equal(appended.status, 200);
    const messagePayload = await appended.json() as { userMessage: { role: string; content: string }; assistantMessage: { role: string; content: string } };
    assert.equal(messagePayload.userMessage.role, "user");
    assert.equal(messagePayload.userMessage.content, "Inspect this repository");
    assert.equal(messagePayload.assistantMessage.role, "assistant");
    assert.equal(messagePayload.assistantMessage.content, "Sofia response");

    const retrieved = await request(baseUrl, "test-token-a", `/v1/conversations/${payload.conversation.id}`);
    assert.equal(retrieved.status, 200);
    const cleared = await request(baseUrl, "test-token-a", `/v1/conversations/${payload.conversation.id}/messages`, "DELETE");
    assert.equal(cleared.status, 200);
    const deleted = await request(baseUrl, "test-token-a", `/v1/conversations/${payload.conversation.id}`, "DELETE");
    assert.equal(deleted.status, 200);
  });
});

test("conversation API prevents cross-key access and forged assistant messages", async () => {
  await withApi(async (baseUrl) => {
    const created = await request(baseUrl, "test-token-a", "/v1/conversations", "POST", {});
    const payload = await created.json() as { conversation: { id: string } };
    const otherOwner = await request(baseUrl, "test-token-b", `/v1/conversations/${payload.conversation.id}`);
    assert.equal(otherOwner.status, 404);
    const forged = await request(baseUrl, "test-token-a", `/v1/conversations/${payload.conversation.id}/messages`, "POST", {
      role: "assistant", content: "Pretend this came from Sofia",
    });
    assert.equal(forged.status, 400);
  });
});

test("conversation mutations require agent:run scope and validate JSON shapes", async () => {
  await withApi(async (baseUrl) => {
    const denied = await request(baseUrl, "read-only-token", "/v1/conversations", "POST", {});
    assert.equal(denied.status, 403);
    const invalid = await request(baseUrl, "test-token-a", "/v1/conversations", "POST", null);
    assert.equal(invalid.status, 400);
  });
});


test("conversation API supports async turns and reconnectable polling", async () => {
  await withApi(async (baseUrl) => {
    const created = await request(baseUrl, "test-token-a", "/v1/conversations", "POST", {});
    const payload = await created.json() as { conversation: { id: string } };
    const submitted = await request(baseUrl, "test-token-a", `/v1/conversations/${payload.conversation.id}/messages`, "POST", {
      role: "user", content: "Continue in the background", async: true,
    });
    assert.equal(submitted.status, 202);
    const accepted = await submitted.json() as { run: { id: string; status: string }; pollUrl: string };
    assert.ok(accepted.pollUrl.includes(accepted.run.id));

    let polled: { status: string; assistantMessage?: { content: string } } | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await request(baseUrl, "test-token-a", accepted.pollUrl);
      assert.equal(response.status, 200);
      polled = await response.json() as { status: string; assistantMessage?: { content: string } };
      if (polled.status === "completed" && polled.assistantMessage) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(polled?.status, "completed");
    assert.equal(polled?.assistantMessage?.content, "Sofia response");

    const stream = await request(baseUrl, "test-token-a", accepted.pollUrl + "/stream");
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/i);
    const streamed = await stream.text();
    assert.match(streamed, /"status":"completed"/);
    assert.match(streamed, /"content":"Sofia response"/);
  });
});


test("conversation synchronous turns enforce the per-key concurrency limit without consuming a rejected turn", async () => {
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  await withApi(async (baseUrl) => {
    const created = await request(baseUrl, "test-token-a", "/v1/conversations", "POST", {});
    const payload = await created.json() as { conversation: { id: string } };
    const path = `/v1/conversations/${payload.conversation.id}/messages`;
    const firstTurn = request(baseUrl, "test-token-a", path, "POST", { role: "user", content: "First slow turn" });

    try {
      await started;
      const secondCreated = await request(baseUrl, "test-token-a", "/v1/conversations", "POST", {});
      const secondPayload = await secondCreated.json() as { conversation: { id: string } };
      const rejected = await request(baseUrl, "test-token-a", `/v1/conversations/${secondPayload.conversation.id}/messages`, "POST", { role: "user", content: "Second turn should be rejected" });
      assert.equal(rejected.status, 429);
      const rejection = await rejected.json() as { error: string };
      assert.equal(rejection.error, "concurrency_limit");
      const secondSaved = await request(baseUrl, "test-token-a", `/v1/conversations/${secondPayload.conversation.id}`);
      const secondSavedPayload = await secondSaved.json() as { conversation: { messages: Array<{ content: string }> } };
      assert.deepEqual(secondSavedPayload.conversation.messages, []);
    } finally {
      release();
    }

    const first = await firstTurn;
    assert.equal(first.status, 200);
    const saved = await request(baseUrl, "test-token-a", `/v1/conversations/${payload.conversation.id}`);
    const savedPayload = await saved.json() as { conversation: { messages: Array<{ role: string; content: string }> } };
    assert.deepEqual(savedPayload.conversation.messages.map((message) => message.content), ["First slow turn", "Sofia response"]);
  }, {
    maxConcurrentRunsPerKey: 1,
    generate: async () => {
      notifyStarted();
      await gate;
      return { text: "Sofia response", assistantMessage: { role: "assistant", content: "Sofia response" } };
    },
  });
});


test("invalid messages do not consume run quota", async () => {
  await withApi(async (baseUrl) => {
    const created = await request(baseUrl, "test-token-a", "/v1/conversations", "POST", {});
    const payload = await created.json() as { conversation: { id: string } };
    const invalid = await request(baseUrl, "test-token-a", `/v1/conversations/${payload.conversation.id}/messages`, "POST", {
      role: "user", content: "   ",
    });
    assert.equal(invalid.status, 400);
    const usage = await request(baseUrl, "test-token-a", "/v1/usage");
    const stats = await usage.json() as { runs: number };
    assert.equal(stats.runs, 0);
  }, { maxRunsPerKeyPerDay: 1 });
});

test("clearing an async conversation while a turn runs prevents an orphaned assistant reply", async () => {
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  await withApi(async (baseUrl) => {
    const created = await request(baseUrl, "test-token-a", "/v1/conversations", "POST", {});
    const payload = await created.json() as { conversation: { id: string } };
    const submitted = await request(baseUrl, "test-token-a", `/v1/conversations/${payload.conversation.id}/messages`, "POST", {
      role: "user", content: "Slow task", async: true,
    });
    const accepted = await submitted.json() as { run: { id: string }; pollUrl: string };
    try {
      await started;
      const cleared = await request(baseUrl, "test-token-a", `/v1/conversations/${payload.conversation.id}/messages`, "DELETE");
      assert.equal(cleared.status, 200);
    } finally {
      release();
    }
    let status = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await request(baseUrl, "test-token-a", accepted.pollUrl);
      const result = await response.json() as { status: string };
      status = result.status;
      if (status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(status, "completed");
    const history = await request(baseUrl, "test-token-a", `/v1/conversations/${payload.conversation.id}`);
    const saved = await history.json() as { conversation: { messages: unknown[] } };
    assert.deepEqual(saved.conversation.messages, []);
  }, {
    generate: async () => {
      notifyStarted();
      await gate;
      return { text: "Sofia response", assistantMessage: { role: "assistant", content: "Sofia response" } };
    },
  });
});

test("long successful model output is preserved as a successful turn with bounded history", async () => {
  const output = "x".repeat(25_000);
  await withApi(async (baseUrl) => {
    const created = await request(baseUrl, "test-token-a", "/v1/conversations", "POST", {});
    const payload = await created.json() as { conversation: { id: string } };
    const response = await request(baseUrl, "test-token-a", `/v1/conversations/${payload.conversation.id}/messages`, "POST", {
      role: "user", content: "Generate a long response",
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { assistantMessage: { content: string }; result: { output: string } };
    assert.equal(result.result.output.length, 25_000);
    assert.ok(result.assistantMessage.content.length <= 20_000);
    assert.match(result.assistantMessage.content, /truncated in conversation history/);
  }, { generate: async () => ({ text: output, assistantMessage: { role: "assistant", content: output } }) });
});


test("conversation rejects a second active turn in the same session without appending it", async () => {
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  await withApi(async (baseUrl) => {
    const created = await request(baseUrl, "test-token-a", "/v1/conversations", "POST", {});
    const payload = await created.json() as { conversation: { id: string } };
    const path = `/v1/conversations/${payload.conversation.id}/messages`;
    const first = await request(baseUrl, "test-token-a", path, "POST", {
      role: "user", content: "First asynchronous turn", async: true,
    });
    assert.equal(first.status, 202);
    await started;

    const second = await request(baseUrl, "test-token-a", path, "POST", {
      role: "user", content: "This must not enter history yet",
    });
    assert.equal(second.status, 409);
    assert.equal((await second.json() as { error: string }).error, "conversation_turn_in_progress");

    const whileRunning = await request(baseUrl, "test-token-a", `/v1/conversations/${payload.conversation.id}`);
    const runningSession = await whileRunning.json() as { conversation: { messages: Array<{ content: string }> } };
    assert.deepEqual(runningSession.conversation.messages.map((message) => message.content), ["First asynchronous turn"]);
    release();

    const firstPayload = await first.json() as { pollUrl: string };
    let status = "queued";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const polled = await request(baseUrl, "test-token-a", firstPayload.pollUrl);
      const value = await polled.json() as { status: string };
      status = value.status;
      if (status === "completed" || status === "failed" || status === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(status, "completed");
  }, {
    generate: async () => {
      notifyStarted();
      await gate;
      return { text: "Sofia response", assistantMessage: { role: "assistant", content: "Sofia response" } };
    },
  });
});

test("cancelling an async conversation turn stops the run and preserves a terminal status", async () => {
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  await withApi(async (baseUrl) => {
    const created = await request(baseUrl, "test-token-a", "/v1/conversations", "POST", {});
    const payload = await created.json() as { conversation: { id: string } };
    const submitted = await request(baseUrl, "test-token-a", `/v1/conversations/${payload.conversation.id}/messages`, "POST", {
      role: "user", content: "Cancel this background task", async: true,
    });
    assert.equal(submitted.status, 202);
    const accepted = await submitted.json() as { run: { id: string }; pollUrl: string };

    try {
      await started;
      const cancelled = await request(baseUrl, "test-token-a", `/v1/agent/runs/${accepted.run.id}`, "DELETE");
      assert.equal(cancelled.status, 200);
      const cancelledPayload = await cancelled.json() as { status: string };
      assert.equal(cancelledPayload.status, "cancelled");
    } finally {
      release();
    }

    let finalStatus = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const polled = await request(baseUrl, "test-token-a", accepted.pollUrl);
      const value = await polled.json() as { status: string };
      finalStatus = value.status;
      if (finalStatus === "cancelled" || finalStatus === "failed" || finalStatus === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(finalStatus, "cancelled");
    const session = await request(baseUrl, "test-token-a", `/v1/conversations/${payload.conversation.id}`);
    const saved = await session.json() as { conversation: { messages: Array<{ role: string }> } };
    assert.deepEqual(saved.conversation.messages.map((message) => message.role), ["user"]);
  }, {
    generate: async () => {
      notifyStarted();
      await gate;
      return { text: "This response must not be appended", assistantMessage: { role: "assistant", content: "This response must not be appended" } };
    },
  });
});

test("async run admission returns 503 and does not start work when durable persistence fails", async () => {
  let generated = false;
  const failingStore: RunRecordStore = {
    save: async () => { throw new Error("disk unavailable"); },
    remove: async () => undefined,
    loadAllSync: () => [],
  };
  await withApi(async (baseUrl) => {
    const response = await request(baseUrl, "test-token-a", "/v1/agent/runs", "POST", {
      task: "This must not start",
      async: true,
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: string }).error, "run_persistence_unavailable");
    assert.equal(generated, false);
  }, {
    runStore: failingStore,
    generate: async () => {
      generated = true;
      return { text: "Unexpected generation", assistantMessage: { role: "assistant", content: "Unexpected generation" } };
    },
  });
});
