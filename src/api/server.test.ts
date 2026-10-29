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


test("async run terminal callback receives the final result and original notification context", async () => {
  let notification: { run: { id: string; status: string; result?: { output?: string } }; input: { task: string; context?: string } } | undefined;
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "Final answer for notification." }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
  }, {
    apiKeys: { "notify-test-key": ["agent:run", "agent:read"] },
    onRunTerminal: async (run, input) => { notification = { run, input }; },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const started = await fetch(`${baseUrl}/v1/agent/runs`, {
      method: "POST",
      headers: { authorization: "Bearer notify-test-key", "content-type": "application/json" },
      body: JSON.stringify({
        task: "complete a task",
        async: true,
        context: "Origin: Slack message event. Slack user ID: UALLOWED. Channel ID: CALLOWED. Message timestamp: 1790000000.000001.",
      }),
    });
    assert.equal(started.status, 202);
    for (let attempt = 0; attempt < 100 && !notification; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(notification, "terminal callback should run after the async task finishes");
    assert.equal(notification.run.status, "completed");
    assert.match(notification.run.id, /^[0-9a-f-]{36}$/i);
    assert.match(notification.run.result?.output ?? "", /Final answer for notification/);
    assert.equal(notification.input.task, "complete a task");
    assert.match(notification.input.context ?? "", /Message timestamp: 1790000000\.000001/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("configured LINE webhook route preserves raw body and forwards the signature before API authentication", async () => {
  let receivedBody = "";
  let receivedSignature: string | undefined;
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "Unused by webhook test." }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Unused by webhook test." }) },
  }, {
    apiKeys: {},
    lineWebhookRoute: {
      transport: {
        handleWebhook: async (rawBody, signature) => {
          receivedBody = Buffer.from(rawBody).toString("utf8");
          receivedSignature = signature;
          return { status: 200, acceptedEvents: 1 };
        },
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const rawBody = '{ "events" : [{"type":"message"}] }';
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/integrations/line/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-line-signature": "signed-raw-body" },
      body: rawBody,
    });
    assert.equal(response.status, 200);
    assert.equal(receivedBody, rawBody);
    assert.equal(receivedSignature, "signed-raw-body");
    assert.deepEqual(await response.json(), { acceptedEvents: 1 });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
