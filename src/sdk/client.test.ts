import assert from "node:assert/strict";
import test from "node:test";
import { SofiaApiError, SofiaClient } from "./client.js";

const response = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

test("mobile async start returns a durable run ID and sends async=true", async () => {
  let request: RequestInit | undefined;
  const client = new SofiaClient({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    fetchImpl: async (_input, init) => {
      request = init;
      return response(202, { id: "run-123", status: "queued" });
    },
  });

  const result = await client.start({ task: "inspect the project" });
  assert.deepEqual(result, { id: "run-123", status: "queued" });
  assert.equal(request?.method, "POST");
  assert.equal((request?.headers as Record<string, string>).authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(String(request?.body)), { task: "inspect the project", async: true });
});

test("mobile polling retries transient server errors with bounded backoff", async () => {
  let calls = 0;
  const client = new SofiaClient({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return response(503, { error: "provider temporarily unavailable" });
      if (calls === 2) return response(200, { id: "job-1", status: "running" });
      return response(200, { id: "job-1", status: "completed", result: { output: "done", kind: "text", steps: 2 } });
    },
  });

  const result = await client.waitForJob("job-1", { intervalMs: 100, maxIntervalMs: 100, timeoutMs: 2_000 });
  assert.equal(result.status, "completed");
  assert.equal(calls, 3);
});

test("mobile polling stops promptly when the caller aborts", async () => {
  const controller = new AbortController();
  const client = new SofiaClient({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    fetchImpl: async () => response(200, { id: "job-1", status: "running" }),
  });
  const waiting = client.waitForJob("job-1", {
    intervalMs: 500,
    timeoutMs: 5_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(new Error("user navigated away")), 25);
  await assert.rejects(waiting, /user navigated away/);
});

test("SDK surfaces structured API errors and refuses insecure remote endpoints", async () => {
  const client = new SofiaClient({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    fetchImpl: async () => response(403, { error: "forbidden" }),
  });
  await assert.rejects(client.start({ task: "no access" }), (error: unknown) => {
    assert.ok(error instanceof SofiaApiError);
    assert.equal(error.status, 403);
    assert.equal(error.message, "forbidden");
    return true;
  });
  assert.throws(() => new SofiaClient({ apiKey: "test-key", baseUrl: "http://api.example.test" }), /HTTPS/);
});

test("SDK rejects API URLs with embedded credentials, query strings, or fragments", () => {
  assert.throws(
    () => new SofiaClient({ apiKey: "test-key", baseUrl: "https://user:pass@api.example.test" }),
    /embedded credentials/,
  );
  assert.throws(
    () => new SofiaClient({ apiKey: "test-key", baseUrl: "https://api.example.test?token=unexpected" }),
    /query string or fragment/,
  );
  assert.throws(
    () => new SofiaClient({ apiKey: "test-key", baseUrl: "https://api.example.test/#route" }),
    /query string or fragment/,
  );
});

test("SDK permits HTTP only for loopback development endpoints", () => {
  assert.doesNotThrow(() => new SofiaClient({ apiKey: "test-key", baseUrl: "http://localhost:3000" }));
  assert.doesNotThrow(() => new SofiaClient({ apiKey: "test-key", baseUrl: "http://127.0.0.1:3000" }));
  assert.throws(() => new SofiaClient({ apiKey: "test-key", baseUrl: "http://api.example.test" }), /HTTPS/);
});

test("SDK aborts stalled mobile requests at the configured timeout", async () => {
  const client = new SofiaClient({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    requestTimeoutMs: 20,
    fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error("missing timeout signal"));
      const fail = () => reject(signal.reason ?? new Error("aborted"));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    }),
  });
  await assert.rejects(client.start({ task: "must not hang forever" }), /timed out/i);
});


test("SDK exposes owner-scoped conversation operations and async polling", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new SofiaClient({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/v1/conversations") && init?.method === "POST") {
        return response(201, { conversation: { id: "conversation-123", title: "Chat", createdAt: 1, updatedAt: 1, messages: [] } });
      }
      if (url.endsWith("/messages")) {
        return response(202, {
          conversationId: "conversation-123",
          userMessage: { id: "message-1", role: "user", content: "hello", createdAt: 2 },
          run: { id: "run-123", status: "queued" },
          pollUrl: "/v1/conversations/conversation-123/turns/run-123",
          contextTruncated: false,
        });
      }
      if (url.endsWith("/turns/run-123")) {
        return response(200, { conversationId: "conversation-123", runId: "run-123", status: "completed", assistantMessage: { id: "message-2", role: "assistant", content: "hi", createdAt: 3 } });
      }
      if (url.endsWith("/stream")) {
        return new Response("data: {\\"type\\":\\"status\\",\\"status\\":\\"completed\\"}\\n\\n", {
          status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      }
      return response(200, { conversations: [] });
    },
  });

  const conversation = await client.createConversation("Chat");
  assert.equal(conversation.id, "conversation-123");
  const accepted = await client.sendConversationMessage(conversation.id, "hello", { async: true });
  assert.equal("pollUrl" in accepted, true);
  const turn = await client.waitForConversationTurn(conversation.id, "run-123", { timeoutMs: 500 });
  assert.equal(turn.assistantMessage?.content, "hi");
  const stream = await client.openConversationTurnStream(conversation.id, "run-123");
  assert.match(await stream.text(), /completed/);
  assert.equal(calls[1]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { role: "user", content: "hello", async: true });
});
